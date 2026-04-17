// Simpleton Javascript Client
//
//     requires braid-http@~1.3/braid-http-client.js

// --- API ---
//
// on_patches?: (patches) => void
//     processes incoming patches by applying them to the UI/textarea.
//     Patches are guaranteed to be in-order and non-overlapping.
//
//     IMPORTANT: Patches have ABSOLUTE positions — each patch's range
//     refers to positions in the original state (before any patches in
//     this update). When applying multiple patches sequentially, you MUST
//     track a cumulative offset to adjust positions:
//
//       var offset = 0
//       for (var p of patches) {
//           apply_at(p.range[0] + offset, p.range[1] + offset, p.content)
//           offset += p.content.length - (p.range[1] - p.range[0])
//       }
//
//     Without offset tracking, multi-patch updates will corrupt the state.
//
//     Optional. If not provided, simpleton applies patches internally
//     to its own copy of the state, and you can get the new state via
//     on_state (see "Local Edit Absorption" below).
//
//     When provided, simpleton calls this to apply patches externally,
//     then reads back the state via get_state(). This means any un-flushed
//     local edits in the UI are absorbed into client_state after each server
//     update (see "Local Edit Absorption" below).
//
// on_state?: (state) => void
//     called after each server update with the new state
//
// get_patches?: (client_state) => patches
//     returns patches representing diff between client_state and current state,
//     which are guaranteed to be different if this method is being called.
//     (the default does this in a fast/simple way, finding a common prefix
//      and suffix, but you can supply something better, or possibly keep
//      track of patches as they come from your editor)
//
// get_state: () => current_state
//     returns the current state (e.g., textarea.value)
//
// content_type: used for Accept and Content-Type headers
//
// on_error?: (error) => void
//     called when an error occurs (e.g., network failure, digest mismatch)
//
// on_online?: (is_online) => void
//     called when the connection status changes
//
// on_ack?: () => void
//     called when all outstanding PUTs have been acknowledged
//
// send_digests?: boolean
//     if truthy, includes a Repr-Digest header with each PUT
//
// returns { changed, abort }
//     call changed() whenever there is a local change,
//     and the system will call a combination of get_state and
//     get_patches when it needs to. (get_state is required;
//     get_patches is optional.)
//     call abort() to abort the subscription.
//
//
// --- Local Edit Absorption ---
//
// When on_patches is provided, after applying server patches via
// on_patches(), client_state is set to get_state(). If the UI has
// un-flushed local edits (typed but changed() not yet called), those
// edits are silently absorbed into client_state and will never be sent
// as a diff. In practice, the JS avoids this because changed() is
// called on every keystroke, and additionally, each time a PUT
// completes, the code re-diffs and sends any edits that accumulated
// while the PUT was in flight — so local edits are never stuck
// waiting; they flush as soon as a PUT slot opens up.
//
// When on_patches is NOT provided, client_state is updated by applying
// patches to the old client_state only. In this case, you should
// provide on_state to receive the updated state after each server
// update; otherwise your UI will not reflect remote changes.
//
function simpleton_client(url, {
    get_patches,
    get_state,

    on_patches,
    on_state,
    on_error,
    on_online,
    on_ack,

    headers,                  // The user can pass in custom headers
                              // that are forwarded into fetches
    content_type,
    send_digests
}) {
    var peer = Math.random().toString(36).slice(2)
    var client_version = []          // sorted version strings
    var client_state = ""            // text as of client_version
    var char_counter = -1            // char-delta for version IDs
    var dirty = false                // true when local edits exist but haven't been sent
    var is_online = false
    var outstanding_puts = 0

    // extend the headers with merge-type and peer
    headers = {
        ...headers,
        "Merge-Type": "simpleton",
        Peer: peer,
    }

    // Manages both the GET subscription and PUT requests through a single
    // channel with automatic reconnection and PUT queuing.
    var channel = reliable_update_channel(url, {
        reconnect_from_parents: () => client_version.length ? client_version : null,
        get_headers: { ...headers, ...content_type && {Accept: content_type} },
        put_headers: { ...headers, ...content_type && {"Content-Type": content_type} },
        on_update: async update => {
            // ── Parent check ────────────────────────────────────────
            // Core simpleton invariant: only accept updates whose
            // parents match our current version. If we're dirty
            // (have unsent local edits), skip — we'll reconnect
            // once the edits are flushed.
            update.parents.sort()
            if (!dirty && versions_eq(client_version, update.parents))
                await apply_update(update)
        },
        on_status: status => {
            is_online = status.online
            outstanding_puts = status.outstanding_puts
            if (on_online) on_online(status.online)
            if (on_ack && outstanding_puts === 0) on_ack()
            if (dirty && is_online && outstanding_puts < 10)
                try_send()
        },
        on_error: err => on_error && on_error(err),

        // this api is preliminary and undocumented;
        // we use it to tell the reliable_update_channel to die,
        // if there is a digest mismatch on the server,
        // which will result in a 550 status code
        no_retry_status_codes: [550]
    })

    async function apply_update(update) {
        // ── Parse and convert patches ───────────────────────────────
        // braid_fetch provides body and patch content as bytes;
        // body_text and content_text are dynamic properties that
        // decode bytes to a string via a UTF-8 decoder.
        var patches
        if (update.patches) {
            for (let patch of update.patches) {
                patch.range = patch.range.match(/\d+/g).map((x) => 1 * x)
                patch.content = patch.content_text
            }
            patches = update.patches.sort((a, b) => a.range[0] - b.range[0])

            // ── JS-SPECIFIC: Convert code-point ranges to UTF-16 indices ──
            // The wire protocol uses Unicode code-point offsets.
            // JS strings are UTF-16, so we must convert.
            //
            // OTHER LANGUAGES: Skip this conversion if your strings
            // are natively indexed by code points (e.g., Emacs Lisp,
            // Python, Rust's char iterator).
            convert_ranges_codepoints_to_utf16(patches, client_state)
        } else
            // Initial snapshot: convert body to a patch replacing
            // [0,0] so it follows the same code path as incremental
            // patches.
            patches = [{range: [0, 0], content: update.body_text}]


        // ── Apply the update ────────────────────────────────────────
        if (on_patches) {
            // Apply patches to the UI, then read back the
            // full state. Warning: if changed() hasn't been
            // called for recent local edits, get_state() will
            // absorb them into client_state silently — call
            // changed() after every local edit to avoid this.
            on_patches(patches)
            client_state = get_state()
        } else
            // Apply patches to our internal state; the
            // result is delivered via on_state below.
            client_state = apply_patches(client_state, patches)


        // ── Advance version ─────────────────────────────────────────
        // IMPORTANT: This must happen synchronously (before any await)
        // to prevent the changed() accumulation loop from interleaving
        // and capturing a stale client_version during a yield point.
        client_version = update.version

        // ── Notify listener ─────────────────────────────────────────
        // IMPORTANT: No changed() / flush is called here.
        // The JS does NOT send edits after receiving a server
        // update. The PUT response handler's async accumulation
        // loop handles flushing accumulated edits.
        if (on_state) on_state(client_state)

        // Now verify that we did this correct, and are in sync.  We do this
        // at the end, so the prior updating is atomic.
        await check_digest(update, client_state)
    }

    // ── try_send — attempt to flush local edits ───────────────────────
    // Called from changed() and on_status. Diffs client_state vs current
    // state and sends a PUT if there's a change. If dirty but no diff,
    // we may have missed updates while dirty, so reconnect to re-sync.
    function try_send() {
        var new_state = get_state()
        if (new_state === client_state) {
            // No local diff — but we were dirty, meaning we may have
            // skipped incoming updates. Reconnect to catch up.
            dirty = false
            channel.reconnect()
            return
        }

        var patches = get_patches ? get_patches(client_state) :
            [simple_diff(client_state, new_state)]

        // Save JS-index patches before code-point conversion mutates them
        var js_patches = patches.map(p => ({range: [...p.range], content: p.content}))

        // ── JS-SPECIFIC: Convert JS UTF-16 ranges to code-points ────
        // The wire protocol uses code-point offsets. See the
        // inverse conversion in the receive path above.
        //
        // OTHER LANGUAGES: Skip this if your strings are
        // natively code-point indexed.
        convert_ranges_utf16_to_codepoints(patches, client_state)

        for (let patch of patches) {
            // ── Update char_counter ─────────────────────────────────
            // Increment by deleted chars + inserted chars
            char_counter += patch.range[1] - patch.range[0]
            char_counter += count_code_points(patch.content)

            patch.unit = "text"
            patch.range = `[${patch.range[0]}:${patch.range[1]}]`
        }

        // ── Compute version and advance optimistically ──────────────
        var version = [peer + "-" + char_counter]

        var parents = client_version
        client_version = version   // optimistic advance
        client_state = new_state   // update client_state
        dirty = false

        // Send Update — when the PUT completes, on_status fires
        // with updated outstanding_puts, which will call try_send
        // again if dirty.
        if (send_digests)
            get_digest(client_state).then(digest =>
                channel.put({ version, parents, patches,
                    headers: { "Repr-Digest": digest } }))
        else
            channel.put({ version, parents, patches })

        return js_patches
    }

    // ── Public interface ────────────────────────────────────────────────
    return {
      // ── abort() — cancel the subscription ─────────────────────────
      abort: () => channel.close(),

      // ── changed() — call when local edits occur ───────────────────
      // If online and under the PUT limit, sends immediately.
      // Otherwise marks dirty — on_status will flush later.
      changed: () => {
        if (is_online && outstanding_puts < 10)
            return try_send()
        else
            dirty = true
      }
    }

    function versions_eq(a, b) {
        return a.length === b.length && a.every((v, i) => v === b[i])
    }

    // ── JS-SPECIFIC: UTF-16 helpers ─────────────────────────────────────
    // These handle surrogate pairs in UTF-16 JS strings. Characters
    // outside the Basic Multilingual Plane (BMP) are encoded as two
    // 16-bit code units (a surrogate pair: high 0xD800-0xDBFF, low
    // 0xDC00-0xDFFF). Such a pair represents one Unicode code point.
    //
    // OTHER LANGUAGES: You don't need these if your string type is
    // natively indexed by code points.

    function get_char_size(str, utf16_index) {
        const char_code = str.charCodeAt(utf16_index)
        return (char_code >= 0xd800 && char_code <= 0xdbff) ? 2 : 1
    }

    function count_code_points(str) {
        let code_points = 0
        for (let i = 0; i < str.length; i++) {
            if (str.charCodeAt(i) >= 0xd800 && str.charCodeAt(i) <= 0xdbff) i++
            code_points++
        }
        return code_points
    }

    // Converts patch ranges from code-point offsets to UTF-16 indices.
    // Patches must be sorted by range[0].
    function convert_ranges_codepoints_to_utf16(patches, str) {
        let codepoint_index = 0
        let utf16_index = 0
        for (let patch of patches) {
            while (codepoint_index < patch.range[0]) {
                utf16_index += get_char_size(str, utf16_index)
                codepoint_index++
            }
            patch.range[0] = utf16_index

            while (codepoint_index < patch.range[1]) {
                utf16_index += get_char_size(str, utf16_index)
                codepoint_index++
            }
            patch.range[1] = utf16_index
        }
    }

    // Converts patch ranges from UTF-16 indices to code-point offsets.
    // Patches must be sorted by range[0].
    function convert_ranges_utf16_to_codepoints(patches, str) {
        let codepoint_index = 0
        let utf16_index = 0
        for (let patch of patches) {
            while (utf16_index < patch.range[0]) {
                utf16_index += get_char_size(str, utf16_index)
                codepoint_index++
            }
            patch.range[0] = codepoint_index

            while (utf16_index < patch.range[1]) {
                utf16_index += get_char_size(str, utf16_index)
                codepoint_index++
            }
            patch.range[1] = codepoint_index
        }
    }

    // ── simple_diff ─────────────────────────────────────────────────────
    // Finds the longest common prefix and suffix between two strings,
    // returning the minimal edit that transforms `old_str` into `new_str`.
    //
    // Returns: { range: [prefix_len, old_str.length - suffix_len],
    //            content: new_str.slice(prefix_len, new_str.length - suffix_len) }
    //
    // This produces a single contiguous edit. For multi-cursor or
    // multi-region edits, supply a custom get_patches function instead.
    function simple_diff(old_str, new_str) {
        // Find common prefix length
        var prefix_len = 0
        var min_len = Math.min(old_str.length, new_str.length)
        while (prefix_len < min_len && old_str[prefix_len] === new_str[prefix_len]) prefix_len++

        // Don't split a surrogate pair: if prefix ends on a low surrogate,
        // the preceding high surrogate only matched by coincidence (same
        // Unicode block), so back up to include the whole pair in the diff.
        if (prefix_len > 0 && is_low_surrogate(old_str, prefix_len))
            prefix_len--

        // Find common suffix length (from what remains after prefix)
        var suffix_len = 0
        min_len -= prefix_len
        while (suffix_len < min_len && old_str[old_str.length - suffix_len - 1] === new_str[new_str.length - suffix_len - 1]) suffix_len++

        // Same guard for suffixes: if the range end (old_str.length - suffix_len)
        // lands on a low surrogate, the suffix consumed it without its high
        // surrogate, so back up.
        if (suffix_len > 0 && is_low_surrogate(old_str, old_str.length - suffix_len))
            suffix_len--

        return {range: [prefix_len, old_str.length - suffix_len], content: new_str.slice(prefix_len, new_str.length - suffix_len)}
    }

    function is_low_surrogate(str, i) {
        var c = str.charCodeAt(i)
        return c >= 0xdc00 && c <= 0xdfff
    }

    function is_high_surrogate(str, i) {
        var c = str.charCodeAt(i)
        return c >= 0xd800 && c <= 0xdbff
    }

    // ── apply_patches ───────────────────────────────────────────────────
    // Applies patches to a string, tracking cumulative offset.
    // Used when on_patches is not provided, to update
    // client_state directly.
    //
    // Patches must have absolute coordinates (relative to the original
    // string, not to the string after previous patches). The offset
    // variable tracks the cumulative shift from previous patches.
    function apply_patches(state, patches) {
        var offset = 0
        for (var patch of patches) {
            state = state.substring(0, patch.range[0] + offset) + patch.content +
                    state.substring(patch.range[1] + offset)
            offset += patch.content.length - (patch.range[1] - patch.range[0])
        }
        return state
    }

    // get_digest():
    //  - Computes SHA-256 of the UTF-8 encoding of the string
    //  - Formatted as Repr-Digest: sha-256=:<base64-encoded-hash>:
    async function get_digest(str) {
        var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
        return `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(bytes)))}:`
    }
    // check_digest():
    //  - Makes sure the current state matches the digest in the update
    async function check_digest(update, client_state) {
        // If the server sent a repr-digest, verify our state matches.  Throw
        // exception if it fails.
        if (update.extra_headers?.["repr-digest"]?.startsWith('sha-256=')
            && update.extra_headers["repr-digest"] !== await get_digest(client_state)) {
            console.log('repr-digest mismatch!')
            console.log('repr-digest: ' + update.extra_headers["repr-digest"])
            console.log('state: ' + client_state)
            throw new Error('repr-digest mismatch')
        }
    }
}
