# Changelog

## 0.1.11

- Keep the MQTT controller first, show firmware only for the controller, remove the identifier field and compact the device header.
- Rename the device tab to Zigbee and keep MQTT devices on their own tab for remote controllers.
- Search MQTT device entities by name, ID, type, value and topic; filter matching entity rows.
- Show and sort the last state change time in the HA objects table.
- Preserve page and list scroll positions during automatic updates, including the log when reading earlier lines.
- Animate reboot controls until fresh HTTP, LocalLink or non-retained MQTT uptime confirms the controller restart.
- Use the stable HA relation search API and report the failing operation and error code.
- Resolve absolute HA YAML includes through the configuration mount, match directory include behavior, keep readable entries after partial failures and report file-specific diagnostics.

## 0.1.10

- Add compact block and table views for saved controllers, independent list filters, and sortable columns.
- Search by name, host, IP, MAC, firmware and MQTT / LocalLink / LL; keep offline controllers at the bottom in both views.
- Use the agreed column names and show only numeric addresses in the IP column.
- Display the controller area from the Home Assistant device registry.
- Browse MQTT Discovery devices and entity values, distinguish retained messages, and open corresponding devices and entities in HA.
- Add a related HA objects tab using registries, MQTT subscriptions, HA relation search and explicit references in YAML, including includes and packages.
- Enable the Home Assistant API permission for read-only data requests; report unavailable or incomplete relationship data.
- Preserve browser navigation for the new controller tabs.

## 0.1.9

- Restore the SLS sidebar icon style when Home Assistant redraws or recreates the menu.
- Keep a single style and observer controller when the icon module loads again, and disconnect observers for removed menu elements.

## 0.1.8

- Fix the sidebar icon warning remaining visible after Home Assistant has restarted.
- Check pending installation status every 30 seconds and clear the warning once HA registers the icon module.
- Recover previously stuck installations without sending another restart command.

## 0.1.7

- Install the SLS sidebar SVG automatically, validating HA configuration before a single restart; preserve existing frontend settings and adopt an identical manual installation.
- Add the SLS PNG icon to the HA app list.
- Display milliseconds in live log timestamps.
- Reboot local and remote controllers through MQTT, with a choice of available MQTT/HTTP transports; never retain or queue reboot commands.
- Show last-data age and local availability on saved controller cards.
- Hide tracked controllers from discovery, keep only Add for untracked entries, and remove redundant overview controls.
- Support browser Back/Forward and restore controller tabs after reload.

## 0.1.6

- Fix MQTT discovery with the Supervisor service: distinguish MQTT 3.1/3.1.1 from TCP/TLS transport and preserve SSL settings.

## 0.1.5

- Merge the title, theme controls and add button into a single header.
- Add removal from tracking and direct links to controller web interfaces.
- Show green/red availability dots and discovery sources in the visible controller table.
- Discover remote SLS controllers using the HA MQTT service and track them without HTTP access.
- Merge matching LocalLink and MQTT records; do not treat retained heartbeats as live availability.
- Remove IP and uptime captions from saved controller cards, keeping their values.
- Clear the app log buffer without reading controller cache or reconnecting WebSocket.
- Provide an optional frontend module for the exact SLS SVG in the HA sidebar.

## 0.1.4

- Compact page headers, summaries, controller rows, forms and LocalLink tables.
- Remove workspace and local-management labels and the sidebar LocalLink footer.
- Keep each log entry on one line with horizontal scrolling; preserve scroll position.
- Avoid rebuilding unchanged log rows.
- Send the native action: subscribe message and check WebSocket liveness with ping/pong.
- Distinguish an open WebSocket from received log data and count live lines.
- Keep port 80 /ws exclusively and read the cache only when opening Log.

## 0.1.3

- Load the controller log cache once when opening Log; receive further lines only via WebSocket.
- Remove the manual cache load button and periodic cache reads, including after reconnects.
- Handle quick tab switches without showing an older log response.
- Display controller uptime from the time API and LocalLink heartbeats.
- Document refreshing an existing HA sidebar entry after renaming the app.

## 0.1.2

- Rename the application and HA sidebar entry to SLS, keeping the existing installation ID.
- Use the standard microchip icon in the HA sidebar.
- Rename Events to Log; subscribe to and display only log messages.
- Use WebSocket on port 80 at /ws exclusively, including reconnects.
- Hide local interface addresses in the LocalLink heading.
- Show controller connectivity as a green/red dot before the name.
- Show free PSRAM alongside free RAM.

## 0.1.1

- Follow the Home Assistant light/dark theme, with a manual theme selector.
- Use the supplied SLS logo and remove repeated branding and footer.
- Show LocalLink board names, IP, MAC and firmware in separate columns.
- Compact controller rows with a reboot action.
- Load the firmware log cache and refresh it when live events are unavailable.
- Fall back from a silent /ws endpoint to the legacy port 81 with the arduino protocol.
- Start MQTT diagnostics automatically; show controller bridge state separately from broker access.
- Release HTTP connections promptly to preserve the controller's connection slots.

## 0.1.0

- First HAOS application package for amd64 and aarch64.
- LocalLink multicast discovery, multiple gateways and persistent connections.
- SLS API authentication, device list and timed Zigbee pairing.
- MQTT configuration and read-only broker/Discovery diagnostics.
- On-demand WebSocket event log with a legacy port 81 fallback.
- Russian responsive UI through Home Assistant Ingress.
