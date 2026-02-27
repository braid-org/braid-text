// ************************************************************************
// ******* Reference Implementation of Simpleton Client Algorithm *********
// ************************************************************************
//
// This is the canonical JS reference for implementing a simpleton client.
// Other language implementations should mirror this logic exactly, with
// adaptations only for language-specific details (e.g., string encoding).
//
// requires braid-http@~1.3/braid-http-client.js
//
// --- API ---
//
// url: resource endpoint
//
// on_patches?: (patches) => void
//     processes incoming patches by applying them to the UI/textarea.
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
// returns { changed, abort }
//     call changed() whenever there is a local change,
//     and the system will call get_patches when it needs to.
//     call abort() to abort the subscription.
//
// --- Retry and Reconnection Behavior ---
//
// Simpleton relies on braid_fetch for retry/reconnection:
//
// Subscription (GET):
//   retry: () => true — always reconnect on any error (network failure,
//   HTTP error, etc.). Reconnection uses exponential backoff:
//     delay = Math.min(retry_count + 1, 3) * 1000 ms
//   i.e., 1s, 2s, 3s, 3s, 3s, ...
//   On reconnect, sends Parents via the parents callback to resume
//   from where the client left off.
//
// PUT requests:
//   retry: (res) => res.status !== 550 — retry all errors EXCEPT
//   HTTP 550 (Repr-Digest mismatch, meaning client is out of sync).
//   This means:
//     - Connection failure: retried with backoff
//     - HTTP 401, 403, 408, 429, 500, 502, 503, 504, etc.: retried
//     - HTTP 550: out of sync — stop retrying, throw error. The
//       client must be torn down and restarted from scratch.
//
// --- Local Edit Absorption ---
//
// When on_patches is provided, after applying server patches via
// on_patches(), client_state is set to get_state(). If the UI has
// un-flushed local edits (typed but changed() not yet called), those
// edits are silently absorbed into client_state and will never be sent
// as a diff. In practice, the JS avoids this because changed() is
// called on every keystroke and the async accumulation loop clears
// the backlog before a server update arrives.
//
// When on_patches is NOT provided (internal mode), client_state is
// updated by applying patches to the old client_state only — local
// edits stay in the UI and will be captured by the next changed() diff.
//
function simpleton_client(url, {
    on_patches,
    on_state,
    get_patches,
    get_state,
    content_type,

    on_error,
    on_res,
    on_online,
    on_ack,
    send_digests
}) {
    var peer = Math.random().toString(36).substr(2)
    var client_version = []       // sorted list of version strings; the version we think is current
    var client_state = ""            // text content as of client_version (our "client_state")
    var char_counter = -1          // cumulative char-delta for generating version IDs
    var outstanding_changes = 0    // PUTs sent but not yet ACKed
    var max_outstanding_changes = 10  // throttle limit
    var throttled = false
    var throttled_update = null
    var ac = new AbortController()

    // ── Subscription (GET) ──────────────────────────────────────────────
    //
    // Opens a long-lived GET subscription with retry: () => true, meaning
    // any disconnection (network error, HTTP error) triggers automatic
    // reconnection with exponential backoff.
    //
    // The parents callback sends client_version on reconnect, so the
    // server knows where we left off and can send patches from there.
    //
    // IMPORTANT: No changed() / flush is called on reconnect. The
    // subscription simply resumes. Any queued PUTs are retried by
    // braid_fetch independently.
    braid_fetch(url, {
        headers: { "Merge-Type": "simpleton",
            ...(content_type ? {Accept: content_type} : {}) },
        subscribe: true,
        retry: () => true,
        onSubscriptionStatus: (status) => { if (on_online) on_online(status.online) },
        parents: () => client_version.length ? client_version : null,
        peer,
        signal: ac.signal
    }).then(res => {
        if (on_res) on_res(res)
        res.subscribe(async update => {
            // ── Parent check ────────────────────────────────────────
            // Core simpleton invariant: only accept updates whose
            // parents match our client_version exactly. This ensures
            // we stay on a single line of time.
            update.parents.sort()
            if (v_eq(client_version, update.parents)) {
                if (throttled) throttled_update = update
                else await apply_update(update)
            }
        }, on_error)
    }).catch(on_error)

    async function apply_update(update) {
        // ── Advance version BEFORE applying patches ─────────
        // (Single-threaded; no concurrent code runs between
        // these steps, so this is safe. Other implementations
        // may advance after applying — both are equivalent.)
        client_version = update.version
        update.state = update.body_text

        // ── Parse and convert patches ───────────────────────
        if (update.patches) {
            for (let patch of update.patches) {
                patch.range = patch.range.match(/\d+/g).map((x) => 1 * x)
                patch.content = patch.content_text
            }
            update.patches.sort((a, b) => a.range[0] - b.range[0])

            // ── JS-SPECIFIC: Convert code-points to UTF-16 indices ──
            // The wire protocol uses Unicode code-point offsets.
            // JS strings are UTF-16, so we must convert. Characters
            // outside the BMP (emoji, CJK extensions, etc.) take 2
            // UTF-16 code units (a surrogate pair) but count as 1
            // code point.
            //
            // OTHER LANGUAGES: Skip this conversion if your strings
            // are natively indexed by code points (e.g., Emacs Lisp,
            // Python, Rust's char iterator).
            let codepoint_index = 0
            let utf16_index = 0
            for (let patch of update.patches) {
                while (codepoint_index < patch.range[0]) {
                    utf16_index += get_char_size(client_state, utf16_index)
                    codepoint_index++
                }
                patch.range[0] = utf16_index

                while (codepoint_index < patch.range[1]) {
                    utf16_index += get_char_size(client_state, utf16_index)
                    codepoint_index++
                }
                patch.range[1] = utf16_index
            }
        }

        // ── Apply the update ────────────────────────────────
        // Convert initial snapshot body to a patch replacing
        // [0,0] — so initial load follows the same code path
        // as incremental patches.
        var patches = update.patches ||
            [{range: [0, 0], content: update.state}]
        if (on_patches) {
            // EXTERNAL MODE: Apply patches to the UI, then
            // read back the full state. Note: this absorbs
            // any un-flushed local edits into client_state.
            on_patches(patches)
            client_state = get_state()
        } else {
            // INTERNAL MODE: Apply patches to our internal
            // state only. Local edits in the UI are NOT
            // absorbed — they will be captured by the next
            // changed() diff.
            client_state = apply_patches(client_state, patches)
        }

        // ── Digest verification ─────────────────────────────
        // If the server sent a repr-digest, verify our state
        // matches. On mismatch, THROW — this halts the
        // subscription handler. The document is corrupted and
        // continuing would compound the problem.
        if (update.extra_headers &&
            update.extra_headers["repr-digest"] &&
            update.extra_headers["repr-digest"].startsWith('sha-256=') &&
            update.extra_headers["repr-digest"] !== await get_digest(client_state)) {
            console.log('repr-digest mismatch!')
            console.log('repr-digest: ' + update.extra_headers["repr-digest"])
            console.log('state: ' + client_state)
            throw new Error('repr-digest mismatch')
        }

        // ── Notify listener ─────────────────────────────────
        // IMPORTANT: No changed() / flush is called here.
        // The JS does NOT send edits after receiving a server
        // update. The PUT response handler's async accumulation
        // loop handles flushing accumulated edits.
        if (on_state) on_state(client_state)
    }

    // ── Public interface ────────────────────────────────────────────────
    return {
      abort: async () => {
        ac.abort()
      },

      // ── changed() — call when local edits occur ───────────────────
      // This is the entry point for sending local edits. It:
      // 1. Diffs client_state vs current state
      // 2. Checks the throttle (outstanding_changes >= max)
      // 3. Sends a PUT with the diff
      // 4. After the PUT completes, loops to check for MORE accumulated
      //    edits (the async accumulation loop), sending them too.
      //
      // The async accumulation loop (while(true) {...}) is equivalent
      // to a callback-driven flush: after each PUT ACK, re-diff and
      // send again if changed. This ensures edits that accumulate
      // during a PUT round-trip are eventually sent.
      changed: () => {
        function get_change() {
            var new_state = get_state()
            if (new_state === client_state) return null
            var patches = get_patches ? get_patches(client_state) :
                [simple_diff(client_state, new_state)]
            return {patches, new_state}
        }

        var change = get_change()
        if (!change) {
            if (throttled) {
                throttled = false
                if (throttled_update &&
                    v_eq(client_version, throttled_update.parents))
                    apply_update(throttled_update).catch(on_error)
                throttled_update = null
            }
            return
        }

        if (outstanding_changes >= max_outstanding_changes) {
            throttled = true
            return
        }

        var {patches, new_state} = change

        // Save JS-index patches before code-point conversion mutates them
        var js_patches = patches.map(p => ({range: [...p.range], content: p.content}))

        ;(async () => {
            while (true) {
                // ── JS-SPECIFIC: Convert JS UTF-16 indices to code-points ──
                // The wire protocol uses code-point offsets. See the
                // inverse conversion in the receive path above.
                //
                // OTHER LANGUAGES: Skip this if your strings are
                // natively code-point indexed.
                let codepoint_index = 0
                let utf16_index = 0
                for (let patch of patches) {
                    while (utf16_index < patch.range[0]) {
                        utf16_index += get_char_size(client_state, utf16_index)
                        codepoint_index++
                    }
                    patch.range[0] = codepoint_index

                    while (utf16_index < patch.range[1]) {
                        utf16_index += get_char_size(client_state, utf16_index)
                        codepoint_index++
                    }
                    patch.range[1] = codepoint_index

                    // ── Update char_counter ──────────────────────
                    // Increment by deleted chars + inserted chars
                    char_counter += patch.range[1] - patch.range[0]
                    char_counter += count_code_points(patch.content)

                    patch.unit = "text"
                    patch.range = `[${patch.range[0]}:${patch.range[1]}]`
                }

                // ── Compute version and advance optimistically ──
                var version = [peer + "-" + char_counter]

                var parents = client_version
                client_version = version   // optimistic advance
                client_state = new_state      // update client_state

                // ── Send PUT ────────────────────────────────────
                // Uses braid_fetch with retry: (res) => res.status !== 550
                // This means:
                //   - Network failures: retried with backoff
                //   - HTTP 401, 403, 408, 429, 500, 502, 503, 504: retried
                //   - HTTP 550 (Repr-Digest mismatch / out of sync):
                //     give up, throw — client must be re-created
                outstanding_changes++
                try {
                    var r = await braid_fetch(url, {
                        headers: {
                            "Merge-Type": "simpleton",
                            ...send_digests && {"Repr-Digest": await get_digest(client_state)},
                            ...content_type && {"Content-Type": content_type}
                        },
                        method: "PUT",
                        retry: (res) => res.status !== 550,
                        version, parents, patches,
                        peer
                    })
                    if (!r.ok) throw new Error(`bad http status: ${r.status}`)
                } catch (e) {
                    // A 550 means Repr-Digest check failed — we're out
                    // of sync. The client must be torn down and
                    // re-created from scratch.
                    on_error(e)
                    throw e
                }
                outstanding_changes--
                if (on_ack && !outstanding_changes) on_ack()

                throttled = false

                // ── Check for accumulated edits ─────────────────
                // While the PUT was in flight, more local edits may
                // have occurred. Diff again and loop if changed.
                var more = get_change()
                if (!more) return
                ;({patches, new_state} = more)
            }
        })()

        return js_patches
      }
    }

    function v_eq(a, b) {
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

        // Find common suffix length (from what remains after prefix)
        var suffix_len = 0
        min_len -= prefix_len
        while (suffix_len < min_len && old_str[old_str.length - suffix_len - 1] === new_str[new_str.length - suffix_len - 1]) suffix_len++

        return {range: [prefix_len, old_str.length - suffix_len], content: new_str.slice(prefix_len, new_str.length - suffix_len)}
    }

    // ── apply_patches ───────────────────────────────────────────────────
    // Applies patches to a string, tracking cumulative offset.
    // Used in INTERNAL MODE (no on_patches callback) to update
    // client_state without touching the UI.
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

    // ── get_digest ──────────────────────────────────────────────────────
    // Computes SHA-256 of the UTF-8 encoding of the state string,
    // formatted as the Repr-Digest header value:
    //   sha-256=:<base64-encoded-hash>:
    async function get_digest(str) {
        var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
        return `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(bytes)))}:`
    }
}
