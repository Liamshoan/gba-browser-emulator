# gba-browser-emulator

Browser-based GBA emulator page using EmulatorJS. Load your own ROM or homebrew. Includes notes on using REA for reverse engineering analysis.

## Run the page

Serve this folder over HTTP, then open the site. The player is an ES module, so opening `index.html` as a `file://` URL will not load it.

```bash
python3 -m http.server 8080
```

Choose a `.gba` file and press Load & Play. The emulator starts inside a fresh frame. Press Play again after choosing another ROM to replace that frame. In-browser saves use the file name plus the cartridge game code.

## Tests

```bash
npm test
```

That runs `node --test` on the files in `test/`. No extra packages are required.
