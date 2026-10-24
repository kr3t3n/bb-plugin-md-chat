# Markdown Chat

A [bb](https://getbb.app) plugin that opens `.md`, `.markdown` and `.mdx` files in a view where you can send selected text to chat.

Select text in the file to open a menu with two actions:

- **Add to chat** puts the file name and the selection, as a quote, into the thread composer.
- **Reply in side chat** starts a side chat on the selection. The built-in side-chat plugin creates it, so it works like a side chat from the timeline. The side chat agent also gets the file path.

bb's own file preview has "Add to chat" but no side chat. The built-in Docs plugin, which bb uses for Markdown files by default, has neither.

## Install

```sh
bb plugin install git:https://github.com/kr3t3n/bb-plugin-md-chat.git
```

After you install the plugin, bb uses it automatically for Markdown files. To choose a different viewer, open Settings → Files → File openers. To use another viewer for one file, right-click the file link and choose "Open with".

## Use

- **Chat view** draws the file with bb's Markdown component and shows the selection menu.
- **BB preview** shows bb's own preview, with its raw source toggle.
- The reload button reads the file again. The view also checks the file for changes every four seconds while the window is visible.
- If the plugin cannot read a file, it shows bb's preview and gives the reason in the header.

## Limits

- The plugin registers a "File side chat" panel action so it can open side chat tabs. It also shows in the "+" tab launcher, where it only shows a hint.
- Text selection on touch devices is not tested.
- Workspace files need a thread environment. Files larger than 2 MB open in bb's preview.

## Develop

```sh
npm install
bb plugin install .
bb plugin dev
```

## License

MIT
