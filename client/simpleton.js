// Simpleton Javascript Client
//
//     requires braid-http@~1.3/braid-http-client.js
//     and      text-client.js

// --- API ---
//
// on_update?: (update) => new_state
//     called when a server update arrives. The update object contains:
//       - update.patches: array of { range: [start, end], content: string }
//           Ranges are UTF-16 indices (already converted from wire
//           code-point offsets). Patches are sorted by range[0].
//           For the initial snapshot, patches is [{ range: [0, 0], content: full_text }].
//       - update.state: the new text after applying patches internally.
//       - update.version, update.parents, update.extra_headers, etc.
//
//     Patches have ABSOLUTE positions — each patch's range refers to
//     positions in the original state (before any patches in this
//     update). When applying multiple patches sequentially, you MUST
//     track a cumulative offset to adjust positions:
//
//       var offset = 0
//       for (var p of update.patches) {
//           apply_at(p.range[0] + offset, p.range[1] + offset, p.content)
//           offset += p.content.length - (p.range[1] - p.range[0])
//       }
//
//     Must return the new text state after applying the patches.
//     For simple cases, just return update.state. For UI integration
//     (e.g. textarea), apply patches to the UI and return the UI's
//     current text (which may include absorbed local edits).
//     If not provided, simpleton uses update.state internally.
//
// get_patches?: (client_state) => patches
//     returns patches representing diff between client_state and current state,
//     which are guaranteed to be different if this method is being called.
//     (the default does this in a fast/simple way, finding a common prefix
//      and suffix, but you can supply something better, or possibly keep
//      track of patches as they come from your editor)
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
//     call changed(new_state) whenever there is a local change,
//     passing the current text. The system will call get_patches
//     to compute the diff (or use simple_diff if get_patches is
//     not provided).
//     call abort() to abort the subscription.
//
function simpleton_client(url, {
    get_patches,

    on_update,
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
    var is_online = false
    var outstanding_puts = 0
    var pending_state = null         // non-null means dirty (unsent local edits)

    // extend the headers with merge-type and peer
    headers = {
        ...headers,
        "Merge-Type": "simpleton",
        Peer: peer,
    }

    var channel = reliable_update_channel(url, {
        reconnect_from_parents: () => client_version.length ? client_version : null,
        get_headers: { ...headers, ...content_type && {Accept: content_type} },
        put_headers: { ...headers, ...content_type && {"Content-Type": content_type} },
        on_update: async update => {
            update.parents.sort()
            if (pending_state === null && versions_eq(client_version, update.parents))
                await apply_update(update)
        },
        on_status: status => {
            is_online = status.online
            outstanding_puts = status.outstanding_puts
            if (on_online) on_online(is_online)
            if (on_ack && outstanding_puts === 0) on_ack()
            if (pending_state !== null && is_online && outstanding_puts < 10) {
                if (pending_state === client_state) {
                    // this is a special case where the user made changes
                    // while offline (or too many outstanding_puts),
                    // but then reverted those changes,
                    // so we might have missed some updates that we could have applied;
                    // reconnecting will fetch those updates
                    pending_state = null
                    channel.reconnect()
                } else {
                    try_send(pending_state)
                }
            }
        },
        on_error: err => on_error && on_error(err),
        no_retry_status_codes: [550]
    })

    async function apply_update(update) {
        update.patches = text_parse_update(update, client_state)
        update.state = text_apply_patches(client_state, update.patches)

        client_state = on_update ? on_update(update) : update.state

        client_version = update.version
        await check_digest(update, client_state)
    }

    function try_send(new_state) {
        var patches = get_patches ? get_patches(client_state) :
            [simple_diff(client_state, new_state)]

        var prepared = text_prepare_put(patches, client_state)
        char_counter += prepared.version_count

        var version = [peer + "-" + char_counter]
        var parents = client_version
        client_version = version
        client_state = new_state
        pending_state = null

        var update = { version, parents, patches: prepared.patches }
        if (send_digests)
            get_digest(client_state).then(digest =>
                channel.put({ ...update, headers: { "Repr-Digest": digest } }))
        else
            channel.put(update)
    }

    return {
        abort: () => channel.close(),
        changed: (new_state) => {
            if (is_online && outstanding_puts < 10)
                try_send(new_state)
            else
                pending_state = new_state
        }
    }

    function versions_eq(a, b) {
        return a.length === b.length && a.every((v, i) => v === b[i])
    }
}
