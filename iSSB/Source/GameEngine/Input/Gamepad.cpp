
#include "Gamepad.h"
#include "../Output/Console.h"

namespace GameEngine
{
	namespace
	{
		const Sint16 GAMEPAD_AXIS_DEADZONE = 8000;
	}

	SDL_GameController*Gamepad::controllers[Gamepad::MAX_GAMEPADS] = { nullptr, nullptr, nullptr, nullptr };
	SDL_JoystickID Gamepad::instanceIDs[Gamepad::MAX_GAMEPADS] = { -1, -1, -1, -1 };

	bool Gamepad::dpadState[Gamepad::MAX_GAMEPADS][4];
	bool Gamepad::stickState[Gamepad::MAX_GAMEPADS][4];

	bool Gamepad::liveState[Gamepad::MAX_GAMEPADS][Gamepad::BUTTONS_TOTAL];
	bool Gamepad::currentState[Gamepad::MAX_GAMEPADS][Gamepad::BUTTONS_TOTAL];
	bool Gamepad::prevState[Gamepad::MAX_GAMEPADS][Gamepad::BUTTONS_TOTAL];

	void Gamepad::resetSlot(int slot)
	{
		for(int j=0; j<4; j++)
		{
			dpadState[slot][j] = false;
			stickState[slot][j] = false;
		}
		for(int j=0; j<BUTTONS_TOTAL; j++)
		{
			liveState[slot][j] = false;
			currentState[slot][j] = false;
			prevState[slot][j] = false;
		}
	}

	void Gamepad::initialize()
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			controllers[i] = nullptr;
			instanceIDs[i] = -1;
			resetSlot(i);
		}
	}

	void Gamepad::quit()
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			if(controllers[i] != nullptr)
			{
				SDL_GameControllerClose(controllers[i]);
				controllers[i] = nullptr;
				instanceIDs[i] = -1;
			}
		}
	}

	int Gamepad::findSlotForInstance(SDL_JoystickID instanceID)
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			if(controllers[i]!=nullptr && instanceIDs[i]==instanceID)
			{
				return i;
			}
		}
		return -1;
	}

	int Gamepad::findFreeSlot()
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			if(controllers[i]==nullptr)
			{
				return i;
			}
		}
		return -1;
	}

	void Gamepad::deviceAdded(int deviceIndex)
	{
		if(!SDL_IsGameController(deviceIndex))
		{
			// not a recognized game controller layout (e.g. a plain joystick); ignore it
			return;
		}

		if(findFreeSlot()<0)
		{
			// already tracking MAX_GAMEPADS controllers
			return;
		}

		SDL_GameController*controller = SDL_GameControllerOpen(deviceIndex);
		if(controller==nullptr)
		{
			Console::WriteLine((String)"failed to open game controller with error: " + SDL_GetError());
			return;
		}

		SDL_JoystickID instanceID = SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(controller));
		if(findSlotForInstance(instanceID)>=0)
		{
			// already open (SDL can report an already-connected controller again on init)
			SDL_GameControllerClose(controller);
			return;
		}

		int slot = findFreeSlot();
		controllers[slot] = controller;
		instanceIDs[slot] = instanceID;
		resetSlot(slot);

		Console::WriteLine((String)"gamepad connected (player " + (slot+1) + "): " + SDL_GameControllerName(controller));
	}

	void Gamepad::deviceRemoved(SDL_JoystickID instanceID)
	{
		int slot = findSlotForInstance(instanceID);
		if(slot<0)
		{
			return;
		}
		Console::WriteLine((String)"gamepad disconnected (player " + (slot+1) + ")");
		SDL_GameControllerClose(controllers[slot]);
		controllers[slot] = nullptr;
		instanceIDs[slot] = -1;
		resetSlot(slot);
	}

	void Gamepad::setLiveButton(int slot, int button, bool down)
	{
		if(slot<0 || slot>=MAX_GAMEPADS || button<0 || button>=BUTTONS_TOTAL)
		{
			return;
		}
		liveState[slot][button] = down;
	}

	void Gamepad::recomputeDirections(int slot)
	{
		liveState[slot][BUTTON_UP] = dpadState[slot][0] || stickState[slot][0];
		liveState[slot][BUTTON_DOWN] = dpadState[slot][1] || stickState[slot][1];
		liveState[slot][BUTTON_LEFT] = dpadState[slot][2] || stickState[slot][2];
		liveState[slot][BUTTON_RIGHT] = dpadState[slot][3] || stickState[slot][3];
	}

	void Gamepad::buttonEvent(SDL_JoystickID instanceID, unsigned char sdlButton, bool down)
	{
		int slot = findSlotForInstance(instanceID);
		if(slot<0)
		{
			return;
		}

		switch(sdlButton)
		{
			case SDL_CONTROLLER_BUTTON_DPAD_UP:
				dpadState[slot][0] = down;
				recomputeDirections(slot);
				break;

			case SDL_CONTROLLER_BUTTON_DPAD_DOWN:
				dpadState[slot][1] = down;
				recomputeDirections(slot);
				break;

			case SDL_CONTROLLER_BUTTON_DPAD_LEFT:
				dpadState[slot][2] = down;
				recomputeDirections(slot);
				break;

			case SDL_CONTROLLER_BUTTON_DPAD_RIGHT:
				dpadState[slot][3] = down;
				recomputeDirections(slot);
				break;

			case SDL_CONTROLLER_BUTTON_A:
				setLiveButton(slot, BUTTON_A, down);
				break;

			case SDL_CONTROLLER_BUTTON_B:
				setLiveButton(slot, BUTTON_B, down);
				break;

			case SDL_CONTROLLER_BUTTON_X:
				setLiveButton(slot, BUTTON_X, down);
				break;

			case SDL_CONTROLLER_BUTTON_Y:
				setLiveButton(slot, BUTTON_Y, down);
				break;

			case SDL_CONTROLLER_BUTTON_LEFTSHOULDER:
				setLiveButton(slot, BUTTON_LEFTSHOULDER, down);
				break;

			case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER:
				setLiveButton(slot, BUTTON_RIGHTSHOULDER, down);
				break;

			case SDL_CONTROLLER_BUTTON_START:
				setLiveButton(slot, BUTTON_START, down);
				break;

			case SDL_CONTROLLER_BUTTON_BACK:
				setLiveButton(slot, BUTTON_BACK, down);
				break;

			case SDL_CONTROLLER_BUTTON_LEFTSTICK:
				setLiveButton(slot, BUTTON_LEFTSTICK, down);
				break;

			case SDL_CONTROLLER_BUTTON_RIGHTSTICK:
				setLiveButton(slot, BUTTON_RIGHTSTICK, down);
				break;

			default:
				break;
		}
	}

	void Gamepad::axisEvent(SDL_JoystickID instanceID, unsigned char sdlAxis, short value)
	{
		int slot = findSlotForInstance(instanceID);
		if(slot<0)
		{
			return;
		}

		if(sdlAxis==SDL_CONTROLLER_AXIS_LEFTX)
		{
			stickState[slot][2] = (value < -GAMEPAD_AXIS_DEADZONE); // left
			stickState[slot][3] = (value > GAMEPAD_AXIS_DEADZONE); // right
			recomputeDirections(slot);
		}
		else if(sdlAxis==SDL_CONTROLLER_AXIS_LEFTY)
		{
			stickState[slot][0] = (value < -GAMEPAD_AXIS_DEADZONE); // up
			stickState[slot][1] = (value > GAMEPAD_AXIS_DEADZONE); // down
			recomputeDirections(slot);
		}
	}

	void Gamepad::shiftToPrev()
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			for(int j=0; j<BUTTONS_TOTAL; j++)
			{
				prevState[i][j] = currentState[i][j];
			}
		}
	}

	void Gamepad::shiftToCurrent()
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			for(int j=0; j<BUTTONS_TOTAL; j++)
			{
				currentState[i][j] = liveState[i][j];
			}
		}
	}

	bool Gamepad::isConnected(int playerSlot)
	{
		if(playerSlot<0 || playerSlot>=MAX_GAMEPADS)
		{
			return false;
		}
		return controllers[playerSlot]!=nullptr;
	}

	int Gamepad::getConnectedCount()
	{
		int count = 0;
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			if(controllers[i]!=nullptr)
			{
				count++;
			}
		}
		return count;
	}

	const char* Gamepad::getControllerName(int playerSlot)
	{
		if(playerSlot<0 || playerSlot>=MAX_GAMEPADS || controllers[playerSlot]==nullptr)
		{
			return nullptr;
		}
		return SDL_GameControllerName(controllers[playerSlot]);
	}

	bool Gamepad::getButtonPressed(int playerSlot, int button)
	{
		if(playerSlot<0 || playerSlot>=MAX_GAMEPADS || button<0 || button>=BUTTONS_TOTAL)
		{
			return false;
		}
		return currentState[playerSlot][button];
	}

	bool Gamepad::getPrevButtonPressed(int playerSlot, int button)
	{
		if(playerSlot<0 || playerSlot>=MAX_GAMEPADS || button<0 || button>=BUTTONS_TOTAL)
		{
			return false;
		}
		return prevState[playerSlot][button];
	}

	bool Gamepad::getAnyButtonPressed(int button)
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			if(getButtonPressed(i, button))
			{
				return true;
			}
		}
		return false;
	}

	bool Gamepad::getPrevAnyButtonPressed(int button)
	{
		for(int i=0; i<MAX_GAMEPADS; i++)
		{
			if(getPrevButtonPressed(i, button))
			{
				return true;
			}
		}
		return false;
	}
}
