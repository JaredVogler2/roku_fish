# REEFBOUND: The Living Reef - Roku channel

A Roku (BrightScript, roScreen 2D) port of REEFBOUND, the underwater food-web survival game.

Work in progress - this file is replaced by the full guide (controls, build and side-load steps,
differences from the web game) once the port is complete.

    npm install
    npm run lint       # BrighterScript check of channel/source
    npm run package    # dist/reefbound.zip (side-loadable channel, must stay under 4 MB)
    npm run sim        # run the package in a BrightScript simulator and take screenshots
