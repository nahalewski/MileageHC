
#include "P2PTransport.h"
#include <string>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <ctime>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>
#include <random>

#ifdef _WIN32
	#include <winsock2.h>
	#include <ws2tcpip.h>
	#pragma comment(lib, "ws2_32.lib")
	typedef SOCKET socket_t;
	typedef int socklen_t_compat;
	#define LANP2P_CLOSESOCKET closesocket
	#define LANP2P_INVALID_SOCKET INVALID_SOCKET
	#define LANP2P_SOCKET_ERROR SOCKET_ERROR
	static void lanp2p_platform_init()
	{
		static bool started = false;
		if(!started)
		{
			WSADATA wsaData;
			WSAStartup(MAKEWORD(2,2), &wsaData);
			started = true;
		}
	}
#else
	#include <sys/types.h>
	#include <sys/socket.h>
	#include <netinet/in.h>
	#include <netinet/tcp.h>
	#include <arpa/inet.h>
	#include <unistd.h>
	#include <fcntl.h>
	#include <errno.h>
	typedef int socket_t;
	typedef socklen_t socklen_t_compat;
	#define LANP2P_CLOSESOCKET close
	#define LANP2P_INVALID_SOCKET (-1)
	#define LANP2P_SOCKET_ERROR (-1)
	static void lanp2p_platform_init() {}
#endif

// declared here (rather than pulling in CPPBridge.h) to avoid coupling this transport to the
// rest of the engine any more than necessary - implemented per-platform in CPPBridge/ObjCBridge
extern std::string getDeviceName();

namespace
{
	const unsigned short LANP2P_DISCOVERY_PORT = 47710;
	const char*const LANP2P_MAGIC = "ISSBP2P1";
	const int LANP2P_DISCOVERY_INTERVAL_MS = 750;
	const int LANP2P_SEARCH_TIMEOUT_MS = 30000;
	const int LANP2P_HANDSHAKE_TIMEOUT_MS = 4000;

	enum LANP2P_FrameType : unsigned char
	{
		LANP2P_FRAME_HELLO = 1,
		LANP2P_FRAME_DATA = 2
	};

	long lanp2p_now_ms()
	{
		using namespace std::chrono;
		return (long)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
	}

	std::string lanp2p_random_id()
	{
		static const char*const hex = "0123456789abcdef";
		// std::random_device is seeded independently per call (not by wall-clock time or a
		// fixed address), so two sessions created back-to-back in the same process still get
		// distinct IDs - critical, since the discovery protocol uses IDs to recognize peers
		// as distinct from itself and to pick a connection initiator
		std::random_device rd;
		std::mt19937_64 rng(((unsigned long long)rd() << 32) ^ (unsigned long long)rd());
		std::uniform_int_distribution<int> dist(0, 15);
		std::string id;
		id.resize(16);
		for(int i=0; i<16; i++)
		{
			id[i] = hex[dist(rng)];
		}
		return id;
	}

	void lanp2p_set_nonblocking(socket_t sock, bool nonblocking)
	{
#ifdef _WIN32
		u_long mode = nonblocking ? 1 : 0;
		ioctlsocket(sock, FIONBIO, &mode);
#else
		int flags = fcntl(sock, F_GETFL, 0);
		if(nonblocking)
		{
			fcntl(sock, F_SETFL, flags | O_NONBLOCK);
		}
		else
		{
			fcntl(sock, F_SETFL, flags & ~O_NONBLOCK);
		}
#endif
	}

	// blocking send of the exact number of bytes, returns false on any socket error
	bool lanp2p_send_all(socket_t sock, const void*data, unsigned int size)
	{
		const char*bytes = (const char*)data;
		unsigned int sent = 0;
		while(sent < size)
		{
			int result = send(sock, bytes+sent, (int)(size-sent), 0);
			if(result <= 0)
			{
				return false;
			}
			sent += (unsigned int)result;
		}
		return true;
	}

	// blocking receive of the exact number of bytes (socket must be in blocking mode), with an
	// overall deadline in milliseconds; returns false on error, disconnect, or timeout
	bool lanp2p_recv_all(socket_t sock, void*data, unsigned int size, int timeoutMS)
	{
		char*bytes = (char*)data;
		unsigned int received = 0;
		long deadline = lanp2p_now_ms() + timeoutMS;
		while(received < size)
		{
			fd_set readSet;
			FD_ZERO(&readSet);
			FD_SET(sock, &readSet);
			long remaining = deadline - lanp2p_now_ms();
			if(remaining <= 0)
			{
				return false;
			}
			struct timeval tv;
			tv.tv_sec = (long)(remaining/1000);
			tv.tv_usec = (long)((remaining%1000)*1000);
			int selectResult = select((int)(sock+1), &readSet, NULL, NULL, &tv);
			if(selectResult <= 0)
			{
				return false;
			}
			int result = recv(sock, bytes+received, (int)(size-received), 0);
			if(result <= 0)
			{
				return false;
			}
			received += (unsigned int)result;
		}
		return true;
	}

	bool lanp2p_send_frame(socket_t sock, std::mutex&sendMutex, LANP2P_FrameType type, const void*payload, unsigned int payloadSize)
	{
		std::lock_guard<std::mutex> lock(sendMutex);
		unsigned int bodySize = 1 + payloadSize; // type byte + payload
		unsigned int netBodySize = htonl(bodySize);
		if(!lanp2p_send_all(sock, &netBodySize, sizeof(netBodySize)))
		{
			return false;
		}
		unsigned char typeByte = (unsigned char)type;
		if(!lanp2p_send_all(sock, &typeByte, 1))
		{
			return false;
		}
		if(payloadSize>0 && !lanp2p_send_all(sock, payload, payloadSize))
		{
			return false;
		}
		return true;
	}

	bool lanp2p_send_hello(socket_t sock, std::mutex&sendMutex, const std::string&selfID, const std::string&selfName)
	{
		unsigned char payload[512];
		unsigned int offset = 0;
		unsigned char idLen = (unsigned char)selfID.size();
		payload[offset++] = idLen;
		memcpy(payload+offset, selfID.data(), idLen);
		offset += idLen;
		unsigned char nameLen = (unsigned char)(selfName.size()>200 ? 200 : selfName.size());
		payload[offset++] = nameLen;
		memcpy(payload+offset, selfName.data(), nameLen);
		offset += nameLen;
		return lanp2p_send_frame(sock, sendMutex, LANP2P_FRAME_HELLO, payload, offset);
	}
}

struct LANP2P_Session
{
	std::string sessionID;
	std::string selfID;
	std::string selfDisplayName;

	LANP2P_EventHandler handler = NULL;

	socket_t udpSocket = LANP2P_INVALID_SOCKET;
	socket_t tcpListenSocket = LANP2P_INVALID_SOCKET;
	socket_t peerSocket = LANP2P_INVALID_SOCKET;
	unsigned short tcpListenPort = 0;

	std::string peerID;
	std::string peerDisplayName;

	std::atomic<bool> searching{false};
	std::atomic<bool> connected{false};
	std::atomic<bool> shouldStop{false};

	std::thread discoveryThread;
	std::thread recvThread;

	std::mutex sendMutex;
};

namespace
{
	void lanp2p_fire_event(LANP2P_Session*session, LANP2P_Event&event)
	{
		if(session->handler != NULL)
		{
			session->handler(&event);
		}
	}

	void lanp2p_fire_simple(LANP2P_Session*session, LANP2P_EventType type)
	{
		LANP2P_Event event;
		memset(&event, 0, sizeof(event));
		event.type = type;
		lanp2p_fire_event(session, event);
	}

	void lanp2p_fire_connected(LANP2P_Session*session)
	{
		LANP2P_Event event;
		memset(&event, 0, sizeof(event));
		event.type = LANP2P_PEERCONNECTED;
		event.peer.peerID = (char*)session->peerID.c_str();
		event.peer.peerDisplayName = (char*)session->peerDisplayName.c_str();
		lanp2p_fire_event(session, event);
	}

	void lanp2p_fire_disconnected(LANP2P_Session*session)
	{
		LANP2P_Event event;
		memset(&event, 0, sizeof(event));
		event.type = LANP2P_PEERDISCONNECTED;
		event.peer.peerID = (char*)session->peerID.c_str();
		event.peer.peerDisplayName = (char*)session->peerDisplayName.c_str();
		lanp2p_fire_event(session, event);
	}

	void lanp2p_close_socket(socket_t&sock)
	{
		if(sock != LANP2P_INVALID_SOCKET)
		{
			// shutdown() first: this is what actually sends the FIN and reliably wakes up any
			// thread of ours blocked in select()/recv() on this fd (recvThread and the
			// discovery/handshake thread can both still be referencing it). A bare close() from
			// a different thread than the one blocked reading can leave the teardown pending
			// until that blocked call eventually gives up, which the peer has no way to know to
			// wait for - shutdown() ends it immediately for everyone.
#ifdef _WIN32
			shutdown(sock, SD_BOTH);
#else
			shutdown(sock, SHUT_RDWR);
#endif
			LANP2P_CLOSESOCKET(sock);
			sock = LANP2P_INVALID_SOCKET;
		}
	}

	void lanp2p_recv_thread_func(LANP2P_Session*session)
	{
		while(session->connected)
		{
			unsigned int netBodySize = 0;
			if(!lanp2p_recv_all(session->peerSocket, &netBodySize, sizeof(netBodySize), 24*60*60*1000))
			{
				break;
			}
			unsigned int bodySize = ntohl(netBodySize);
			if(bodySize == 0 || bodySize > (16*1024*1024))
			{
				break;
			}
			unsigned char*body = new unsigned char[bodySize];
			if(!lanp2p_recv_all(session->peerSocket, body, bodySize, 24*60*60*1000))
			{
				delete[] body;
				break;
			}
			unsigned char type = body[0];
			if(type == LANP2P_FRAME_DATA && session->connected)
			{
				LANP2P_Event event;
				memset(&event, 0, sizeof(event));
				event.type = LANP2P_RECIEVEDDATA;
				event.peer.peerID = (char*)session->peerID.c_str();
				event.peer.peerDisplayName = (char*)session->peerDisplayName.c_str();
				event.data.data = body+1;
				event.data.size = bodySize-1;
				lanp2p_fire_event(session, event);
			}
			delete[] body;
		}

		bool wasConnected = session->connected.exchange(false);
		lanp2p_close_socket(session->peerSocket);
		if(wasConnected)
		{
			lanp2p_fire_disconnected(session);
		}
	}

	// broadcasts discovery packets and listens for both discovery replies and incoming TCP
	// connections until a peer is found (and a handshake completes) or the search times out
	void lanp2p_discovery_thread_func(LANP2P_Session*session)
	{
		long deadline = lanp2p_now_ms() + LANP2P_SEARCH_TIMEOUT_MS;
		long lastBroadcast = 0;

		std::string discoveryPacket;
		discoveryPacket += LANP2P_MAGIC;
		unsigned char sessionLen = (unsigned char)session->sessionID.size();
		discoveryPacket += (char)sessionLen;
		discoveryPacket += session->sessionID;
		unsigned char idLen = (unsigned char)session->selfID.size();
		discoveryPacket += (char)idLen;
		discoveryPacket += session->selfID;
		unsigned char nameLen = (unsigned char)(session->selfDisplayName.size()>200 ? 200 : session->selfDisplayName.size());
		discoveryPacket += (char)nameLen;
		discoveryPacket += session->selfDisplayName.substr(0, nameLen);
		unsigned short netPort = htons(session->tcpListenPort);
		discoveryPacket.append((const char*)&netPort, sizeof(netPort));

		sockaddr_in broadcastAddr;
		memset(&broadcastAddr, 0, sizeof(broadcastAddr));
		broadcastAddr.sin_family = AF_INET;
		broadcastAddr.sin_port = htons(LANP2P_DISCOVERY_PORT);
		broadcastAddr.sin_addr.s_addr = INADDR_BROADCAST;

		bool foundPeer = false;

		while(!session->shouldStop && !foundPeer && lanp2p_now_ms()<deadline)
		{
			long now = lanp2p_now_ms();
			if(now-lastBroadcast >= LANP2P_DISCOVERY_INTERVAL_MS)
			{
				sendto(session->udpSocket, discoveryPacket.data(), (int)discoveryPacket.size(), 0, (sockaddr*)&broadcastAddr, sizeof(broadcastAddr));
				lastBroadcast = now;
			}

			fd_set readSet;
			FD_ZERO(&readSet);
			FD_SET(session->udpSocket, &readSet);
			FD_SET(session->tcpListenSocket, &readSet);
			socket_t maxSock = session->udpSocket>session->tcpListenSocket ? session->udpSocket : session->tcpListenSocket;

			struct timeval tv;
			tv.tv_sec = 0;
			tv.tv_usec = 200*1000;
			int selectResult = select((int)(maxSock+1), &readSet, NULL, NULL, &tv);
			if(selectResult<=0)
			{
				continue;
			}

			if(FD_ISSET(session->tcpListenSocket, &readSet))
			{
				sockaddr_in fromAddr;
				socklen_t_compat fromLen = sizeof(fromAddr);
				socket_t accepted = accept(session->tcpListenSocket, (sockaddr*)&fromAddr, &fromLen);
				if(accepted != LANP2P_INVALID_SOCKET)
				{
					unsigned int netBodySize = 0;
					if(lanp2p_recv_all(accepted, &netBodySize, sizeof(netBodySize), LANP2P_HANDSHAKE_TIMEOUT_MS))
					{
						unsigned int bodySize = ntohl(netBodySize);
						if(bodySize>0 && bodySize<512)
						{
							unsigned char body[512];
							if(lanp2p_recv_all(accepted, body, bodySize, LANP2P_HANDSHAKE_TIMEOUT_MS) && body[0]==LANP2P_FRAME_HELLO)
							{
								unsigned int off = 1;
								unsigned char remoteIdLen = body[off++];
								std::string remoteID((char*)body+off, remoteIdLen);
								off += remoteIdLen;
								unsigned char remoteNameLen = body[off++];
								std::string remoteName((char*)body+off, remoteNameLen);

								if(lanp2p_send_hello(accepted, session->sendMutex, session->selfID, session->selfDisplayName))
								{
									session->peerSocket = accepted;
									session->peerID = remoteID;
									session->peerDisplayName = remoteName;
									session->connected = true;
									foundPeer = true;
								}
							}
						}
					}
					if(!foundPeer)
					{
						LANP2P_CLOSESOCKET(accepted);
					}
				}
			}

			if(!foundPeer && FD_ISSET(session->udpSocket, &readSet))
			{
				unsigned char buffer[512];
				sockaddr_in fromAddr;
				socklen_t_compat fromLen = sizeof(fromAddr);
				int received = recvfrom(session->udpSocket, (char*)buffer, sizeof(buffer), 0, (sockaddr*)&fromAddr, &fromLen);
				if(received > (int)strlen(LANP2P_MAGIC) && memcmp(buffer, LANP2P_MAGIC, strlen(LANP2P_MAGIC))==0)
				{
					unsigned int off = (unsigned int)strlen(LANP2P_MAGIC);
					unsigned char remoteSessionLen = buffer[off++];
					std::string remoteSession((char*)buffer+off, remoteSessionLen);
					off += remoteSessionLen;
					unsigned char remoteIdLen = buffer[off++];
					std::string remoteID((char*)buffer+off, remoteIdLen);
					off += remoteIdLen;
					unsigned char remoteNameLen = buffer[off++];
					std::string remoteName((char*)buffer+off, remoteNameLen);
					off += remoteNameLen;
					unsigned short remotePort;
					memcpy(&remotePort, buffer+off, sizeof(remotePort));
					remotePort = ntohs(remotePort);

					if(remoteSession == session->sessionID && remoteID != session->selfID)
					{
						// symmetric "peer" mode: whichever ID sorts lower initiates the TCP
						// connection, the other side just waits for it on its listen socket
						if(session->selfID < remoteID)
						{
							socket_t connectSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
							sockaddr_in peerAddr;
							memset(&peerAddr, 0, sizeof(peerAddr));
							peerAddr.sin_family = AF_INET;
							peerAddr.sin_port = htons(remotePort);
							peerAddr.sin_addr = fromAddr.sin_addr;

							lanp2p_set_nonblocking(connectSocket, true);
							connect(connectSocket, (sockaddr*)&peerAddr, sizeof(peerAddr));
							fd_set writeSet;
							FD_ZERO(&writeSet);
							FD_SET(connectSocket, &writeSet);
							struct timeval connectTv;
							connectTv.tv_sec = LANP2P_HANDSHAKE_TIMEOUT_MS/1000;
							connectTv.tv_usec = 0;
							bool connectedOK = false;
							if(select((int)(connectSocket+1), NULL, &writeSet, NULL, &connectTv) > 0)
							{
								int soError = 0;
								socklen_t_compat errLen = sizeof(soError);
								getsockopt(connectSocket, SOL_SOCKET, SO_ERROR, (char*)&soError, &errLen);
								connectedOK = (soError==0);
							}
							lanp2p_set_nonblocking(connectSocket, false);

							if(connectedOK &&
							   lanp2p_send_hello(connectSocket, session->sendMutex, session->selfID, session->selfDisplayName))
							{
								unsigned int netBodySize = 0;
								if(lanp2p_recv_all(connectSocket, &netBodySize, sizeof(netBodySize), LANP2P_HANDSHAKE_TIMEOUT_MS))
								{
									unsigned int bodySize = ntohl(netBodySize);
									if(bodySize>0 && bodySize<512)
									{
										unsigned char body[512];
										if(lanp2p_recv_all(connectSocket, body, bodySize, LANP2P_HANDSHAKE_TIMEOUT_MS) && body[0]==LANP2P_FRAME_HELLO)
										{
											session->peerSocket = connectSocket;
											session->peerID = remoteID;
											session->peerDisplayName = remoteName;
											session->connected = true;
											foundPeer = true;
										}
									}
								}
							}
							if(!foundPeer)
							{
								LANP2P_CLOSESOCKET(connectSocket);
							}
						}
						// else: lower-ID peer will connect to us - just keep polling tcpListenSocket
					}
				}
			}
		}

		lanp2p_close_socket(session->udpSocket);
		lanp2p_close_socket(session->tcpListenSocket);

		session->searching = false;

		if(foundPeer)
		{
			session->recvThread = std::thread(lanp2p_recv_thread_func, session);
			session->recvThread.detach();
			lanp2p_fire_connected(session);
		}
		else
		{
			lanp2p_fire_simple(session, LANP2P_PICKERDIDCANCEL);
		}
	}

	bool lanp2p_setup_sockets(LANP2P_Session*session)
	{
		session->udpSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
		if(session->udpSocket == LANP2P_INVALID_SOCKET)
		{
			return false;
		}
		int reuse = 1;
		setsockopt(session->udpSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));
		int broadcast = 1;
		setsockopt(session->udpSocket, SOL_SOCKET, SO_BROADCAST, (const char*)&broadcast, sizeof(broadcast));

		sockaddr_in udpAddr;
		memset(&udpAddr, 0, sizeof(udpAddr));
		udpAddr.sin_family = AF_INET;
		udpAddr.sin_port = htons(LANP2P_DISCOVERY_PORT);
		udpAddr.sin_addr.s_addr = INADDR_ANY;
		if(bind(session->udpSocket, (sockaddr*)&udpAddr, sizeof(udpAddr)) == LANP2P_SOCKET_ERROR)
		{
			lanp2p_close_socket(session->udpSocket);
			return false;
		}

		session->tcpListenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		if(session->tcpListenSocket == LANP2P_INVALID_SOCKET)
		{
			lanp2p_close_socket(session->udpSocket);
			return false;
		}
		setsockopt(session->tcpListenSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

		sockaddr_in tcpAddr;
		memset(&tcpAddr, 0, sizeof(tcpAddr));
		tcpAddr.sin_family = AF_INET;
		tcpAddr.sin_port = 0; // let the OS assign a free port
		tcpAddr.sin_addr.s_addr = INADDR_ANY;
		if(bind(session->tcpListenSocket, (sockaddr*)&tcpAddr, sizeof(tcpAddr)) == LANP2P_SOCKET_ERROR ||
		   listen(session->tcpListenSocket, 1) == LANP2P_SOCKET_ERROR)
		{
			lanp2p_close_socket(session->udpSocket);
			lanp2p_close_socket(session->tcpListenSocket);
			return false;
		}

		sockaddr_in boundAddr;
		socklen_t_compat boundLen = sizeof(boundAddr);
		getsockname(session->tcpListenSocket, (sockaddr*)&boundAddr, &boundLen);
		session->tcpListenPort = ntohs(boundAddr.sin_port);

		return true;
	}

	void lanp2p_begin_search(LANP2P_Session*session, const char*sessionID)
	{
		if(session->searching || session->connected)
		{
			return;
		}
		session->sessionID = sessionID;
		session->shouldStop = false;

		if(!lanp2p_setup_sockets(session))
		{
			lanp2p_fire_simple(session, LANP2P_PICKERDIDCANCEL);
			return;
		}

		session->searching = true;
		session->discoveryThread = std::thread(lanp2p_discovery_thread_func, session);
		session->discoveryThread.detach();
	}
}

LANP2P_Session* LANP2P_createSession()
{
	lanp2p_platform_init();

	LANP2P_Session*session = new LANP2P_Session();
	session->selfID = lanp2p_random_id();
	std::string deviceName = getDeviceName();
	if(deviceName.empty() || deviceName=="Unknown")
	{
		session->selfDisplayName = "Player-" + session->selfID.substr(0,4);
	}
	else
	{
		session->selfDisplayName = deviceName;
	}
	return session;
}

void LANP2P_destroySession(LANP2P_Session*session)
{
	if(session==NULL)
	{
		return;
	}
	LANP2P_endSession(session);
	delete session;
}

void LANP2P_searchForPeers(LANP2P_Session*session, const char*sessionID)
{
	lanp2p_begin_search(session, sessionID);
}

void LANP2P_searchForClients(LANP2P_Session*session, const char*sessionID)
{
	// this project only ever uses the symmetric "peer" mode (see P2PManager::searchForPeers);
	// treat client/server search the same way rather than leaving them as dead no-ops
	lanp2p_begin_search(session, sessionID);
}

void LANP2P_searchForServer(LANP2P_Session*session, const char*sessionID)
{
	lanp2p_begin_search(session, sessionID);
}

void LANP2P_setEventHandler(LANP2P_Session*session, LANP2P_EventHandler callback)
{
	session->handler = callback;
}

SDL_bool LANP2P_isConnected(LANP2P_Session*session)
{
	return session->connected ? SDL_TRUE : SDL_FALSE;
}

SDL_bool LANP2P_isConnectedToPeer(LANP2P_Session*session, const char*peerID)
{
	return (session->connected && session->peerID==peerID) ? SDL_TRUE : SDL_FALSE;
}

SDL_bool LANP2P_acceptConnectionRequest(LANP2P_Session*session, const char*peerID)
{
	// connections auto-handshake as soon as a matching peer is discovered (there is no
	// separate "incoming request" step in the LAN transport - see LANP2P_PEERCONNECTED)
	return session->connected && session->peerID==peerID ? SDL_TRUE : SDL_FALSE;
}

void LANP2P_denyConnectionRequest(LANP2P_Session*session, const char*peerID)
{
	//
}

void LANP2P_getPeerDisplayName(LANP2P_Session*session, const char*peerID, char*dispName)
{
	if(session->peerID==peerID)
	{
		strncpy(dispName, session->peerDisplayName.c_str(), 39);
		dispName[39] = '\0';
	}
	else
	{
		dispName[0] = '\0';
	}
}

void LANP2P_getSelfDisplayName(LANP2P_Session*session, char*dispName)
{
	strncpy(dispName, session->selfDisplayName.c_str(), 39);
	dispName[39] = '\0';
}

void LANP2P_getSelfID(LANP2P_Session*session, char*selfID)
{
	strncpy(selfID, session->selfID.c_str(), 39);
	selfID[39] = '\0';
}

void LANP2P_getSessionID(LANP2P_Session*session, char*sessionID)
{
	strncpy(sessionID, session->sessionID.c_str(), 39);
	sessionID[39] = '\0';
}

void LANP2P_sendData(LANP2P_Session*session, void*data, unsigned int size, LANP2P_SendDataMode mode)
{
	if(!session->connected)
	{
		return;
	}
	if(!lanp2p_send_frame(session->peerSocket, session->sendMutex, LANP2P_FRAME_DATA, data, size))
	{
		bool wasConnected = session->connected.exchange(false);
		if(wasConnected)
		{
			lanp2p_close_socket(session->peerSocket);
			lanp2p_fire_disconnected(session);
		}
	}
}

void LANP2P_sendDataToPeers(LANP2P_Session*session, char**peers, unsigned int numPeers, void*data, unsigned int size, LANP2P_SendDataMode mode)
{
	// only one peer is ever connected (2-player), so sending "to peers" and "to everyone" are
	// the same operation here as long as our one peer is in the given list
	for(unsigned int i=0; i<numPeers; i++)
	{
		if(session->peerID == peers[i])
		{
			LANP2P_sendData(session, data, size, mode);
			return;
		}
	}
}

void LANP2P_disconnectPeer(LANP2P_Session*session, const char*peerID)
{
	if(session->connected && session->peerID==peerID)
	{
		bool wasConnected = session->connected.exchange(false);
		lanp2p_close_socket(session->peerSocket);
		if(wasConnected)
		{
			lanp2p_fire_disconnected(session);
		}
	}
}

void LANP2P_endSession(LANP2P_Session*session)
{
	session->shouldStop = true;
	session->connected = false;
	lanp2p_close_socket(session->udpSocket);
	lanp2p_close_socket(session->tcpListenSocket);
	lanp2p_close_socket(session->peerSocket);
}
