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

Or try opening the URL in [Braid-Chrome](https://github.com/braid-org/braid-chrome), or another Braid client, to edit it directly!

Check out the `server-demo.js` file to see examples for how to add access control, and a `/pages` endpoint to show all the edited pages.

## General Use on Server

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

## General Use on Client

```html
<script src="https://unpkg.com/braid-text/simpleton-client.js"></script>
<script>

  // connect to the server
  let simpleton = simpleton_client('https://example.org/some-resource', {
    apply_remote_update: ({ state, patches }) => {

      // Apply the incoming state or patches to local text here.

      // Then return the new state of textarea as a string:
      return new_state
    },
    generate_local_diff_update: (prev_state) => {

      // Compute diff between prev_state ^ and the current textarea string, such as:
      //
      //   var patches = [{
      //     range: [5:5],
      //     content: " World"
      //   }]
      //
      // ...to insert something after a prev_state of "Hello".

      // Then return the new state (as a string) and the diff (as `patches`)
      return {new_state, patches}
    },
  })
    
  ...
    
  // When changes occur in client's textarea, let simpleton know,
  // so that it can call generate_local_diff_update() to ask for them.
  simpleton.changed()

</script>
```

See [editor.html](https://raw.githubusercontent.com/braid-org/braid-text/master/editor.html) for a simple working example.

## Client API

```javascript
simpleton = simpleton_client(url, options)
```

- `url`: The URL of the resource to synchronize with.
- `options`: An object containing the following properties:
  - `apply_remote_update`: A function that will be called whenever an update is received from the server. It should have the following signature:

    ```javascript
    ({state, patches}) => {...}
    ```

    - `state`: If present, represents the new value of the text.
    - `patches`: If present, an array of patch objects, each representing a string-replace operation. Each patch object has the following properties:
      - `range`: An array of two numbers, `[start, end]`, specifying the start and end positions of the characters to be deleted.
      - `content`: The text to be inserted in place of the deleted characters.

    Note that patches will always be in order, but the range positions of each patch reference the original string, i.e., the second patch's range values do not take into account the application of the first patch.

    The function should apply the `state` or `patches` to the local text and return the new state.

  - `generate_local_diff_update`: A function that will be called whenever a local update occurs, but may be delayed if the network is congested. It should have the following signature:

    ```javascript
    (prev_state) => {...}
    ```

    The function should calculate the difference between `prev_state` and the current state, and express this difference as an array of patches (similar to the ones described in `apply_remote_update`).

    If a difference is detected, the function should return an object with the following properties:
    - `new_state`: The current state of the text.
    - `patches`: An array of patch objects representing the changes.

    If no difference is detected, the function should return `undefined` or `null`.

  - `content_type`: <small style="color:lightgrey">[optional]</small> If set, this value will be sent in the `Accept` and `Content-Type` headers to the server.

- `simpleton.changed()`: Call this function to report local updates whenever they occur, e.g., in the `oninput` event handler of a textarea being synchronized.
