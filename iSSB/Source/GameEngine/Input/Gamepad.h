
#include <SDL_joystick.h>
#include <SDL_gamecontroller.h>

#pragma once

namespace GameEngine
{
	// Generic, engine-level abstraction over connected game controllers (Xbox, PlayStation/DualSense,
	// Switch Pro, Razer Kishi, and any other device SDL recognizes as a "game controller").
	// SDL's GameController API normalizes all of these to the same button/axis layout, so no
	// per-brand handling is required here.
	class Gamepad
	{
		friend class Application;
	public:
		static const int MAX_GAMEPADS = 4;

		static const int BUTTON_UP = 0;
		static const int BUTTON_DOWN = 1;
		static const int BUTTON_LEFT = 2;
		static const int BUTTON_RIGHT = 3;
		static const int BUTTON_A = 4;
		static const int BUTTON_B = 5;
		static const int BUTTON_X = 6;
		static const int BUTTON_Y = 7;
		static const int BUTTON_LEFTSHOULDER = 8;
		static const int BUTTON_RIGHTSHOULDER = 9;
		static const int BUTTON_START = 10;
		static const int BUTTON_BACK = 11;
		static const int BUTTON_LEFTSTICK = 12;
		static const int BUTTON_RIGHTSTICK = 13;
		static const int BUTTONS_TOTAL = 14;

		static bool isConnected(int playerSlot);
		static int getConnectedCount();
		static const char* getControllerName(int playerSlot);

		static bool getButtonPressed(int playerSlot, int button);
		static bool getPrevButtonPressed(int playerSlot, int button);
		static bool getAnyButtonPressed(int button);
		static bool getPrevAnyButtonPressed(int button);

	private:
		static SDL_GameController*controllers[MAX_GAMEPADS];
		static SDL_JoystickID instanceIDs[MAX_GAMEPADS];

		// direction state, tracked separately for the d-pad and the left stick so that
		// releasing one doesn't clobber a direction still being held on the other
		static bool dpadState[MAX_GAMEPADS][4];
		static bool stickState[MAX_GAMEPADS][4];

		static bool liveState[MAX_GAMEPADS][BUTTONS_TOTAL];
		static bool currentState[MAX_GAMEPADS][BUTTONS_TOTAL];
		static bool prevState[MAX_GAMEPADS][BUTTONS_TOTAL];

		static void initialize();
		static void quit();

		static void deviceAdded(int deviceIndex);
		static void deviceRemoved(SDL_JoystickID instanceID);
		static void buttonEvent(SDL_JoystickID instanceID, unsigned char sdlButton, bool down);
		static void axisEvent(SDL_JoystickID instanceID, unsigned char sdlAxis, short value);

		static void shiftToPrev();
		static void shiftToCurrent();

		static int findSlotForInstance(SDL_JoystickID instanceID);
		static int findFreeSlot();
		static void resetSlot(int slot);
		static void recomputeDirections(int slot);
		static void setLiveButton(int slot, int button, bool down);
	};
}
