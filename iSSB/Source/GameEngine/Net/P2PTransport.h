
#pragma once

#include <SDL.h>

// Drop-in replacement for the old External/SDL/SDL_p2p library, which only ever had a working
// backend for iOS (via the long-removed GKSession/GKPeerPickerController GameKit APIs) - every
// other platform silently no-op'd. This implements the same "peer" session model (see
// GameEngine::P2PManager, which is the only consumer of this API) over plain LAN sockets:
// peers advertise/discover each other with a UDP broadcast on the local WiFi network, then talk
// over a plain TCP connection. Symbol names are prefixed LANP2P_ (not P2P_) so this can coexist
// in a build alongside the untouched vendored SDL_p2p sources without a link collision.

#ifdef __cplusplus
extern "C"
{
#endif

	typedef struct LANP2P_Session LANP2P_Session;

	typedef enum
	{
		LANP2P_PEERCONNECTED = 1,
		LANP2P_PEERDISCONNECTED = 2,
		LANP2P_PEERREQUESTEDCONNECTION = 3,
		LANP2P_PICKERDIDCANCEL = 4,
		LANP2P_RECIEVEDDATA = 5
	} LANP2P_EventType;

	struct LANP2P_PeerInfo
	{
		char*peerID;
		char*peerDisplayName;
	};

	struct LANP2P_DataInfo
	{
		void*data;
		unsigned int size;
	};

	typedef struct
	{
		LANP2P_EventType type;
		struct LANP2P_PeerInfo peer;
		struct LANP2P_DataInfo data;
	} LANP2P_Event;

	typedef void (*LANP2P_EventHandler)(LANP2P_Event*);

	typedef enum
	{
		LANP2P_SENDDATA_RELIABLE,
		LANP2P_SENDDATA_UNRELIABLE
	} LANP2P_SendDataMode;

	extern DECLSPEC LANP2P_Session* SDLCALL LANP2P_createSession();
	extern DECLSPEC void SDLCALL LANP2P_destroySession(LANP2P_Session* session);

	extern DECLSPEC void SDLCALL LANP2P_searchForPeers(LANP2P_Session* session, const char*sessionID);
	extern DECLSPEC void SDLCALL LANP2P_searchForClients(LANP2P_Session* session, const char*sessionID);
	extern DECLSPEC void SDLCALL LANP2P_searchForServer(LANP2P_Session* session, const char*sessionID);

	extern DECLSPEC void SDLCALL LANP2P_setEventHandler(LANP2P_Session*session, LANP2P_EventHandler callback);

	extern DECLSPEC SDL_bool SDLCALL LANP2P_isConnected(LANP2P_Session*session);
	extern DECLSPEC SDL_bool SDLCALL LANP2P_isConnectedToPeer(LANP2P_Session*session, const char*peerID);

	extern DECLSPEC SDL_bool SDLCALL LANP2P_acceptConnectionRequest(LANP2P_Session*session, const char*peerID);
	extern DECLSPEC void SDLCALL LANP2P_denyConnectionRequest(LANP2P_Session*session, const char*peerID);

	extern DECLSPEC void SDLCALL LANP2P_getPeerDisplayName(LANP2P_Session*session, const char*peerID, char*dispName);
	extern DECLSPEC void SDLCALL LANP2P_getSelfDisplayName(LANP2P_Session*session, char*dispName);
	extern DECLSPEC void SDLCALL LANP2P_getSelfID(LANP2P_Session*session, char*selfID);
	extern DECLSPEC void SDLCALL LANP2P_getSessionID(LANP2P_Session*session, char*sessionID);

	extern DECLSPEC void SDLCALL LANP2P_sendData(LANP2P_Session*session, void*data, unsigned int size, LANP2P_SendDataMode mode);
	extern DECLSPEC void SDLCALL LANP2P_sendDataToPeers(LANP2P_Session*session, char**peers, unsigned int numPeers, void*data, unsigned int size, LANP2P_SendDataMode mode);

	extern DECLSPEC void SDLCALL LANP2P_disconnectPeer(LANP2P_Session*session, const char*peerID);
	extern DECLSPEC void SDLCALL LANP2P_endSession(LANP2P_Session*session);

#ifdef __cplusplus
}
#endif
