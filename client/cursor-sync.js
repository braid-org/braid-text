// cursor-sync.js — Sync cursor/selection positions via braid-http
//
// Requires braid-http-client.js (for braid_fetch)
//
// Usage:
//   var cursors = await cursor_client(url, {
//       peer: 'my-id',
//       get_text: () => textarea.value,
//       on_change: (selections) => { ... },
//   })
//   if (!cursors) return  // server doesn't support cursors
//   cursors.online()      // call when text subscription is online
//   cursors.offline()     // call when text subscription goes offline
//   cursors.set(selectionStart, selectionEnd)
//   cursors.changed(patches)
//   cursors.destroy()
//
async function cursor_client(url, { peer, get_text, on_change }) {
    // --- feature detection: HEAD probe ---
    try {
        var head_res = await fetch(url, {
            method: 'HEAD',
            headers: { 'Accept': 'application/text-cursors+json' }
        })
        var ct = head_res.headers.get('content-type') || ''
        if (!ct.includes('application/text-cursors+json')) return null
    } catch (e) { return null }

    var selections = {}     // peer_id -> [{ from, to }]  in JS string indices
    var online = false      // true after online(), false after offline()
    var pending = null      // buffered cursor snapshot while offline
    var last_sent = null
    var last_ranges = null  // last cursor ranges (JS indices) for re-PUT on reconnect
    var send_timer = null
    var ac = new AbortController()
    var put_ac = null       // AbortController for in-flight PUT retry

    // --- code-point <-> JS index helpers ---

    function code_point_to_index_map(s) {
        var m = []
        var c = 0
        for (var i = 0; i < s.length; i++) {
            m[c] = i
            var code = s.charCodeAt(i)
            if (code >= 0xd800 && code <= 0xdbff) i++
            c++
        }
        m[c] = i
        return m
    }

    function js_index_to_code_point(s, idx) {
        var c = 0
        for (var i = 0; i < idx; i++) {
            var code = s.charCodeAt(i)
            if (code >= 0xd800 && code <= 0xdbff) i++
            c++
        }
        return c
    }

    // --- position transform through edits ---

    function transform_pos(pos, del_start, del_len, ins_len) {
        if (del_len === 0) {
            if (pos < del_start) return pos
            return pos + ins_len
        }
        if (pos <= del_start) return pos
        if (pos <= del_start + del_len) return del_start + ins_len
        return pos - del_len + ins_len
    }

    // --- process cursor data (code-points → JS indices) ---

    function process_data(data, is_snapshot) {
        var text = get_text()
        var m = code_point_to_index_map(text)
        var changed = {}

        // Full snapshot: remove peers no longer present
        if (is_snapshot) {
            for (var id of Object.keys(selections)) {
                if (!(id in data)) {
                    delete selections[id]
                    changed[id] = []
                }
            }
        }

        for (var id of Object.keys(data)) {
            if (id === peer) continue
            var ranges = data[id]
            if (!ranges) {
                delete selections[id]
                changed[id] = []
            } else {
                selections[id] = ranges.map(function(r) {
                    return {
                        from: m[r.from] !== undefined ? m[r.from] : text.length,
                        to: m[r.to] !== undefined ? m[r.to] : text.length,
                    }
                })
                changed[id] = selections[id]
            }
        }

        if (on_change) on_change(changed)
    }

    // --- PUT helper ---

    function do_put(ranges) {
        if (put_ac) put_ac.abort()
        put_ac = new AbortController()
        var text = get_text()
        var cp_ranges = ranges.map(function(r) {
            return {
                from: js_index_to_code_point(text, r.from),
                to: js_index_to_code_point(text, r.to),
            }
        })
        braid_fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/text-cursors+json',
                Peer: peer,
                'Content-Range': 'json [' + JSON.stringify(peer) + ']',
            },
            body: JSON.stringify(cp_ranges),
            retry: function(res) { return res.status === 425 },
            signal: put_ac.signal,
        }).catch(function() {})
    }

    // --- subscribe for remote cursors ---
    // The subscription stays alive always. Data is only processed when online.

    var connected_before = false
    braid_fetch(url, {
        subscribe: true,
        retry: { onRes: function() {
            if (connected_before && online) {
                // Reconnecting — go offline to clear stale cursors.
                // The application will call online() again when text is ready.
                var changed = {}
                for (var id of Object.keys(selections)) changed[id] = []
                selections = {}
                online = false
                pending = null
                if (on_change && Object.keys(changed).length) on_change(changed)
            }
            connected_before = true
        }},
        peer,
        headers: {
            Accept: 'application/text-cursors+json',
            Heartbeats: '10',
        },
        signal: ac.signal,
    }).then(function(r) {
        r.subscribe(function(update) {
            var data
            var is_snapshot = false
            if (update.body_text != null) {
                data = JSON.parse(update.body_text)
                is_snapshot = true
            } else if (update.patches && update.patches.length) {
                var p = update.patches[0]
                var ct = p.content_text
                data = { [JSON.parse(p.range)[0]]: ct ? JSON.parse(ct) : null }
            } else return

            if (!online) {
                // Buffer snapshot data; apply patches to buffered data
                if (is_snapshot || !pending) pending = {}
                if (is_snapshot) pending = data
                else for (var id of Object.keys(data)) pending[id] = data[id]
                return
            }

            process_data(data, is_snapshot)
        })
    })

    return {
        // Call when text subscription comes online.
        // Processes any buffered cursor data and re-PUTs local cursor.
        online: function() {
            online = true
            if (pending) {
                process_data(pending, true)
                pending = null
            }
            if (last_ranges) do_put(last_ranges)
        },

        // Call when text subscription goes offline.
        // Clears all remote cursors.
        offline: function() {
            online = false
            pending = null
            if (put_ac) put_ac.abort()
            if (send_timer) { clearTimeout(send_timer); send_timer = null }
            var changed = {}
            for (var id of Object.keys(selections)) {
                changed[id] = []
            }
            selections = {}
            if (on_change && Object.keys(changed).length) on_change(changed)
        },

        // Send local cursor/selection position (JS string indices).
        // Supports multiple selections: set(from, to) or set([{from, to}, ...])
        set: function(from_or_ranges, to) {
            var ranges
            if (Array.isArray(from_or_ranges)) {
                ranges = from_or_ranges
            } else {
                ranges = [{ from: from_or_ranges, to: to }]
            }

            // Skip if same as last sent
            var key = JSON.stringify(ranges)
            if (key === last_sent) return
            last_sent = key
            last_ranges = ranges

            if (!online) return

            // Debounce 50ms
            if (send_timer) clearTimeout(send_timer)
            send_timer = setTimeout(function() { do_put(ranges) }, 50)
        },

        // Transform all stored remote cursor positions through text edits.
        // patches: [{ range: [start, end], content: string }] in JS string indices.
        changed: function(patches) {
            var any_changed = false
            for (var id of Object.keys(selections)) {
                selections[id] = selections[id].map(function(sel) {
                    var from = sel.from
                    var to = sel.to
                    for (var p of patches) {
                        var del_len = p.range[1] - p.range[0]
                        var ins_len = p.content.length
                        from = transform_pos(from, p.range[0], del_len, ins_len)
                        to = transform_pos(to, p.range[0], del_len, ins_len)
                    }
                    return { from, to }
                })
                any_changed = true
            }
            if (any_changed && on_change) {
                // Report all current selections
                var all = {}
                for (var id of Object.keys(selections))
                    all[id] = selections[id]
                on_change(all)
            }
        },

        // Get current selections (for reading state)
        get_selections: function() {
            var copy = {}
            for (var id of Object.keys(selections))
                copy[id] = selections[id]
            return copy
        },

        destroy: function() {
            ac.abort()
            if (put_ac) put_ac.abort()
            if (send_timer) clearTimeout(send_timer)
        },
    }
}
