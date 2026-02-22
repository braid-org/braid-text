# Collaborative text over Braid-HTTP

This library provides a simple http route handler, along with client code, enabling fast text synchronization over a standard protocol.

- Supports [Braid-HTTP](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-braid-http-04.txt) protocol
- Supports [Simpleton](https://braid.org/meeting-76/simpleton) merge-type
  - Enables light clients
    - As little as 50 lines of code!
    - With zero history overhead on client
  - Supports [backpressure](https://braid.org/meeting-81/simpleton) to run smoothly on constrained servers
  - Server merges with Diamond-Types
- Supports [Diamond Types](https://github.com/josephg/diamond-types) merge-type
  - Fully peer-to-peer CRDT
  - Fast / Robust / Extensively fuzz-tested
- Developed in [braid.org](https://braid.org)

This library makes it safe, easy & efficient to add collaborative text editing to every user-editable string in your web app.  Make your app multiplayer!

Check out the [**demo video**](https://braid.org/video/https://invisiblecollege.s3.us-west-1.amazonaws.com/braid-meeting-86.mp4#4755) 📺 from the Braid 86 release!

### Demo: a Wiki!

This will run a collaboratively-editable wiki:

```shell
npm install
node server-demo.js
```

Now open these URLs in your browser:
  - http://localhost:8888/demo (to see the demo text)
  - http://localhost:8888/demo?editor (to edit the text)
  - http://localhost:8888/demo?markdown-editor (to edit it as markdown)
  - http://localhost:8888/any-other-path?editor (to create a new page, just go to its URL, and then start editing)

Or try opening the URL in [Braid-Chrome](https://github.com/braid-org/braid-chrome), or [another Braid client](https://bloop.monster/simpleditor), to edit it directly!

Check out the `server-demo.js` file to see examples for how to add simple access control, where a user need only enter a password into a cookie in the javascript console like: `document.cookie = 'password'`; and a `/pages` endpoint to show all the edited pages.

## General Use as Server

Install it in your project:
```shell
npm install braid-text
```

Import the request handler into your code, and use it to handle HTTP requests wherever you want:

```javascript
var braid_text = require("braid-text")

http_server.on("request", (req, res) => {
  // Your server logic...

  // Whenever desired, serve braid text for this request/response:
  braid_text.serve(req, res)
})
```

## Server API

`braid_text.db_folder = './braid-text-db' // <-- this is the default`
  - This is where the Diamond-Types history files will be stored for each resource.
  - This folder will be created if it doesn't exist.
  - The files for a resource will all be prefixed with a url-encoding of `key` within this folder.

`braid_text.serve(req, res, options)`
  - `req`: Incoming HTTP request object.
  - `res`: Outgoing HTTP response object.
  - `options`: <small style="color:lightgrey">[optional]</small> An object containing additional options:
    - `key`:  <small style="color:lightgrey">[optional]</small> ID of text resource to sync with.  Defaults to `req.url`.
  - This is the main method of this library, and does all the work to handle Braid-HTTP `GET` and `PUT` requests concerned with a specific text resource.

`await braid_text.get(key)`
  - `key`: ID of text resource.
  - Returns the text of the resource as a string.

`await braid_text.get(key, options)`
  - `key`: ID of text resource.
  - `options`: An object containing additional options, like http headers:
    - `version`:  <small style="color:lightgrey">[optional]</small> The [version](https://datatracker.ietf.org/doc/html/draft-toomim-httpbis-braid-http#section-2) to get, as an array of strings.  (The array is typically length 1.)
    - `parents`:  <small style="color:lightgrey">[optional]</small> The version to start the subscription at, as an array of strings.
    - `subscribe: cb`:  <small style="color:lightgrey">[optional]</small> Instead of returning the state; [subscribes](https://datatracker.ietf.org/doc/html/draft-toomim-httpbis-braid-http#section-4) to the state, and calls `cb` with the initial state and each update. The function `cb` will be called with a Braid [update](https://datatracker.ietf.org/doc/html/draft-toomim-httpbis-braid-http#section-3) of the form `cb({version, parents, body, patches})`.
    - `merge_type`: <small style="color:lightgrey">[optional]</small> The CRDT/OT [merge-type](https://raw.githubusercontent.com/braid-org/braid-spec/master/draft-toomim-httpbis-merge-types-00.txt) algorithm to emulate.  Currently supports `"simpleton"` (default) and `"dt"`.
    - `peer`: <small style="color:lightgrey">[optional]</small> Unique string ID that identifies the peer making the subscription. Mutations will not be echoed back to the same peer that `PUT`s them, for any `PUT` setting the same `peer` header.
  - If NOT subscribing, returns `{version: <current_version>, body: <current-text>}`. If subscribing, returns nothing.

`await braid_text.put(key, options)`
  - `key`: ID of text resource.
  - `options`: An object containing additional options, like http headers:
    - `version`:  <small style="color:lightgrey">[optional]</small> The [version](https://datatracker.ietf.org/doc/html/draft-toomim-httpbis-braid-http#section-2) being `PUT`, as an array of strings. Will be generated if not provided.
    - `parents`:  <small style="color:lightgrey">[optional]</small> The previous version being updated, as array of strings. Defaults to the server’s current version.
    - `body`: <small style="color:lightgrey">[optional]</small> Use this to completely replace the existing text with this new text.  See Braid [updates](https://datatracker.ietf.org/doc/html/draft-toomim-httpbis-braid-http#section-3).
    - `patches`: <small style="color:lightgrey">[optional]</small> Array of patches, each of the form `{unit: 'text', range: '[1:3]', content: 'hi'}`, which would replace the second and third unicode code-points in the text with `hi`.  See Braid [Range-Patches](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-range-patch-01.txt).
    - `peer`: <small style="color:lightgrey">[optional]</small> Identifies this peer. This mutation will not be echoed back to `get` subscriptions that use this same `peer` header.

## General Use as Client

Here's a basic running example to start:

```html
<!-- 1. Your textarea -->
<textarea id="my_textarea"></textarea>

<!-- 2. Include the libraries -->
<script src="https://unpkg.com/braid-http@~1.3/braid-http-client.js"></script>
<script src="https://unpkg.com/braid-text@~0.3/client/simpleton-sync.js"></script>

<!-- 3. Wire it up -->
<script>
  // Connect to server
  var simpleton = simpleton_client('https://braid.org/public-sandbox', {
    on_state: state => my_textarea.value = state,  // incoming changes
    get_state: () => my_textarea.value             // outgoing changes
  })

  // Tell simpleton when user types
  my_textarea.oninput = () => simpleton.changed()
</script>
```

You should see some text in a box if you run this, and if you run it in another tab, you should be able to edit that text collaboratively.

### How It Works

The client uses a **decoupled update mechanism** for efficiency:

1. When users type, you call `simpleton.changed()` to notify the client that something changed
2. The client decides *when* to actually fetch and send updates based on network conditions
3. When ready, it calls your `get_state` function to get the current text

This design prevents network congestion and handles disconnections gracefully. For example, if you edit offline for hours, the client will send just one efficient diff when reconnecting, rather than thousands of individual keystrokes.

### Advanced Integration

For better performance and control, you can work with patches instead of full text:

#### Patch Format

Each patch is an object with two properties:
- `range`: `[start, end]` - The range of characters to delete
- `content`: The text to insert at that position

Patches in an array each have positions which refer to the **original text** before any other patches are applied.

#### Receiving Patches

Instead of receiving complete text updates, you can process individual changes:

```javascript
var simpleton = simpleton_client(url, {
  on_patches: (patches) => {
    // Apply each patch to your editor..
  },
  get_state: () => editor.getValue()
})
```

This is more efficient for large documents and helps preserve cursor position.

#### Custom Patch Generation

You can provide your own diff algorithm or use patches from your editor's API:

```javascript
var simpleton = simpleton_client(url, {
  on_state: state => editor.setValue(state),
  get_state: () => editor.getValue(),
  get_patches: (prev_state) => {
    // Use your own diff algorithm or editor's change tracking
    return compute_patches(prev_state, editor.getValue())
  }
})
```

See [editor.html](https://github.com/braid-org/braid-text/blob/master/editor.html) for a complete example.

## Client API

### Constructor

```javascript
simpleton = simpleton_client(url, options)
```

Creates a new Simpleton client that synchronizes with a Braid-Text server.

**Parameters:**
- `url`: The URL of the resource to synchronize with
- `options`: Configuration object with the following properties:

#### Required Options

- `get_state`: **[required]** Function that returns the current text state
  ```javascript
  () => current_text_string
  ```

#### Incoming Updates (choose one)

- `on_state`: <small style="color:lightgrey">[optional]</small> Callback for receiving complete state updates
  ```javascript
  (state) => { /* update your UI with new text */ }
  ```

- `on_patches`: <small style="color:lightgrey">[optional]</small> Callback for receiving incremental changes
  ```javascript
  (patches) => { /* apply patches to your editor */ }
  ```
  Each patch has:
  - `range`: `[start, end]` - positions to delete (in original text coordinates)
  - `content`: Text to insert at that position
  
  **Note:** All patches reference positions in the original text before any patches are applied.

#### Outgoing Updates

- `get_patches`: <small style="color:lightgrey">[optional]</small> Custom function to generate patches
  ```javascript
  (previous_state) => array_of_patches
  ```
  If not provided, uses a simple prefix/suffix diff algorithm.

  **Note:** All patches must reference positions in the original text before any patches are applied.

#### Additional Options

- `content_type`: <small style="color:lightgrey">[optional]</small> MIME type for `Accept` and `Content-Type` headers

### Methods

- `simpleton.changed()`: Notify the client that local changes have occurred. Call this in your editor's change event handler. The client will call `get_patches` and `get_state` when it's ready to send updates.

### Deprecated Options

The following options are deprecated and should be replaced with the new API:

- ~~`apply_remote_update`~~ → Use `on_patches` or `on_state` instead
- ~~`generate_local_diff_update`~~ → Use `get_patches` and `get_state` instead

## Testing

### to run unit tests:
first run the test server:

    npm install
    node test/server.js

then open http://localhost:8889/test.html, and the boxes should turn green as the tests pass.

### to run fuzz tests:

    npm install
    node test/test.js

if the last output line looks like this, good:

    t = 9999, seed = 1397019, best_n = Infinity @ NaN

but it's bad if it looks like this:

    t = 9999, seed = 1397019, best_n = 5 @ 1396791

the number at the end is the random seed that generated the simplest error example
