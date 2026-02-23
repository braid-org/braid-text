// requires braid-http@~1.3/braid-http-client.js
// 
// url: resource endpoint
//
// on_patches?: (patches) => void
//     processes incoming patches
//
// on_state?: (state) => void
//     processes incoming state
//
// get_patches?: (prev_state) => patches
//     returns patches representing diff
//       between prev_state and current state,
//     which are guaranteed to be different
//       if this method is being called
//     (the default does this in a fast/simple way,
//      finding a common prefix and suffix,
//      but you can supply something better,
//      or possibly keep track of patches as they come from your editor)
//
// get_state: () => current_state
//     returns the current state
//
// [DEPRECATED] apply_remote_update: ({patches, state}) => {...}
//     this is for incoming changes;
//     one of these will be non-null,
//     and can be applied to the current state.
//
// [DEPRECATED] generate_local_diff_update: (prev_state) => {...}
//     this is to generate outgoing changes,
//     and if there are changes, returns { patches, new_state }
//
// content_type: used for Accept and Content-Type headers
//
// returns { changed }
//     call changed whenever there is a local change,
//     and the system will call get_patches when it needs to.
//
function simpleton_client(url, {
    on_patches,
    on_state,
    get_patches,
    get_state,
    apply_remote_update, // DEPRECATED
    generate_local_diff_update, // DEPRECATED
    content_type,

    on_error,
    on_res,
    on_online,
    on_ack,
    send_digests
}) {
    var peer = Math.random().toString(36).substr(2)
    var current_version = []
    var prev_state = ""
    var char_counter = -1
    var outstanding_changes = 0
    var max_outstanding_changes = 10
    var ac = new AbortController()

    // temporary: our old code uses this deprecated api,
    //        and our old code wants to send digests..
    if (apply_remote_update) send_digests = true

    braid_fetch(url, {
        headers: { "Merge-Type": "simpleton",
            ...(content_type ? {Accept: content_type} : {}) },
        subscribe: true,
        retry: () => true,
        onSubscriptionStatus: (status) => { if (on_online) on_online(status) },
        parents: () => current_version.length ? current_version : null,
        peer,
        signal: ac.signal
    }).then(res => {
        if (on_res) on_res(res)
        res.subscribe(async update => {
            // Only accept the update if its parents == our current version
            update.parents.sort()
            if (current_version.length === update.parents.length
                && current_version.every((v, i) => v === update.parents[i])) {
                current_version = update.version.sort()
                update.state = update.body_text

                if (update.patches) {
                    for (let p of update.patches) {
                        p.range = p.range.match(/\d+/g).map((x) => 1 * x)
                        p.content = p.content_text
                    }
                    update.patches.sort((a, b) => a.range[0] - b.range[0])

                    // convert from code-points to js-indicies
                    let c = 0
                    let i = 0
                    for (let p of update.patches) {
                        while (c < p.range[0]) {
                            i += get_char_size(prev_state, i)
                            c++
                        }
                        p.range[0] = i

                        while (c < p.range[1]) {
                            i += get_char_size(prev_state, i)
                            c++
                        }
                        p.range[1] = i
                    }
                }

                if (apply_remote_update) {
                    // DEPRECATED
                    prev_state = apply_remote_update(update)
                } else {
                    var patches = update.patches ||
                        [{range: [0, 0], content: update.state}]
                    if (on_patches) {
                        on_patches(patches)
                        prev_state = get_state()
                    } else prev_state = apply_patches(prev_state, patches)
                }

                // if the server gave us a digest,
                // go ahead and check it against our new state..
                if (update.extra_headers &&
                    update.extra_headers["repr-digest"] &&
                    update.extra_headers["repr-digest"].startsWith('sha-256=') &&
                    update.extra_headers["repr-digest"] !== await get_digest(prev_state)) {
                    console.log('repr-digest mismatch!')
                    console.log('repr-digest: ' + update.extra_headers["repr-digest"])
                    console.log('state: ' + prev_state)
                    throw new Error('repr-digest mismatch')
                }

                if (on_state) on_state(prev_state)
            }
        }, on_error)
    }).catch(on_error)
    
    return {
      stop: async () => {
        ac.abort()
      },
      changed: () => {
        if (outstanding_changes >= max_outstanding_changes) return

        if (generate_local_diff_update) {
            // DEPRECATED
            var update = generate_local_diff_update(prev_state)
            if (!update) return   // Stop if there wasn't a change!
            var {patches, new_state} = update
        } else {
            var new_state = get_state()
            if (new_state === prev_state) return // Stop if there wasn't a change!
            var patches = get_patches ? get_patches(prev_state) :
                [simple_diff(prev_state, new_state)]
        }

        // Save JS-index patches before code-point conversion mutates them
        var js_patches = patches.map(p => ({range: [...p.range], content: p.content}))

        ;(async () => {
            while (true) {
                // convert from js-indicies to code-points
                let c = 0
                let i = 0
                for (let p of patches) {
                    while (i < p.range[0]) {
                        i += get_char_size(prev_state, i)
                        c++
                    }
                    p.range[0] = c

                    while (i < p.range[1]) {
                        i += get_char_size(prev_state, i)
                        c++
                    }
                    p.range[1] = c

                    char_counter += p.range[1] - p.range[0]
                    char_counter += count_code_points(p.content)

                    p.unit = "text"
                    p.range = `[${p.range[0]}:${p.range[1]}]`
                }

                var version = [peer + "-" + char_counter]

                var parents = current_version
                current_version = version
                prev_state = new_state

                outstanding_changes++
                try {
                    var r = await braid_fetch(url, {
                        headers: {
                            "Merge-Type": "simpleton",
                            ...send_digests && {"Repr-Digest": await get_digest(prev_state)},
                            ...content_type && {"Content-Type": content_type}
                        },
                        method: "PUT",
                        retry: (res) => res.status !== 550,
                        version, parents, patches,
                        peer
                    })
                    if (!r.ok) throw new Error(`bad http status: ${r.status}${(r.status === 401 || r.status === 403) ? ` (access denied)` : ''}`)
                } catch (e) {
                    on_error(e)
                    throw e
                }
                outstanding_changes--
                if (on_ack && !outstanding_changes) on_ack()

                // Check for more changes that accumulated while we were sending
                if (generate_local_diff_update) {
                    update = generate_local_diff_update(prev_state)
                    if (!update) return
                    ;({patches, new_state} = update)
                } else {
                    new_state = get_state()
                    if (new_state === prev_state) return
                    patches = get_patches ? get_patches(prev_state) :
                        [simple_diff(prev_state, new_state)]
                }
            }
        })()

        return js_patches
      }
    }

    function get_char_size(s, i) {
        const charCode = s.charCodeAt(i)
        return (charCode >= 0xd800 && charCode <= 0xdbff) ? 2 : 1
    }

    function count_code_points(str) {
        let code_points = 0
        for (let i = 0; i < str.length; i++) {
            if (str.charCodeAt(i) >= 0xd800 && str.charCodeAt(i) <= 0xdbff) i++
            code_points++
        }
        return code_points
    }

    function simple_diff(a, b) {
        // Find common prefix
        var p = 0
        var len = Math.min(a.length, b.length)
        while (p < len && a[p] === b[p]) p++

        // Find common suffix (from what remains after prefix)
        var s = 0
        len -= p
        while (s < len && a[a.length - s - 1] === b[b.length - s - 1]) s++

        return {range: [p, a.length - s], content: b.slice(p, b.length - s)}
    }

    function apply_patches(state, patches) {
        var offset = 0
        for (var p of patches) {
            state = state.substring(0, p.range[0] + offset) + p.content + 
                    state.substring(p.range[1] + offset)
            offset += p.content.length - (p.range[1] - p.range[0])
        }
        return state
    }

    async function get_digest(s) {
        var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
        return `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(bytes)))}:`
    }
}
