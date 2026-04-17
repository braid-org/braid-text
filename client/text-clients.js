// Text utility functions for simpleton text clients
//
// Used by simpleton.js and directly by editors.


// ── UTF-16 / Unicode code-point helpers ────────────────────────────────
// JS strings are UTF-16. Characters outside the Basic Multilingual Plane
// (BMP) are encoded as two 16-bit code units (a surrogate pair: high
// 0xD800-0xDBFF, low 0xDC00-0xDFFF). Such a pair represents one Unicode
// code point.
//
// OTHER LANGUAGES: You don't need these if your string type is natively
// indexed by code points.

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

function is_low_surrogate(str, i) {
    var c = str.charCodeAt(i)
    return c >= 0xdc00 && c <= 0xdfff
}

function is_high_surrogate(str, i) {
    var c = str.charCodeAt(i)
    return c >= 0xd800 && c <= 0xdbff
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


// ── simple_diff ────────────────────────────────────────────────────────
// Finds the longest common prefix and suffix between two strings,
// returning the minimal edit that transforms `old_str` into `new_str`.
//
// Returns: { range: [prefix_len, old_str.length - suffix_len],
//            content: new_str.slice(prefix_len, new_str.length - suffix_len) }
//
// This produces a single contiguous edit. For multi-cursor or
// multi-region edits, supply a custom get_patches function instead.
function simple_diff(old_str, new_str) {
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


// ── text_apply_patches ─────────────────────────────────────────────────
// Applies patches to a string, tracking cumulative offset.
//
// Patches must have absolute coordinates (relative to the original
// string, not to the string after previous patches). The offset
// variable tracks the cumulative shift from previous patches.
function text_apply_patches(state, patches) {
    var offset = 0
    for (var patch of patches) {
        state = state.substring(0, patch.range[0] + offset) + patch.content +
                state.substring(patch.range[1] + offset)
        offset += patch.content.length - (patch.range[1] - patch.range[0])
    }
    return state
}


// ── Digest helpers ─────────────────────────────────────────────────────

// Computes SHA-256 of the UTF-8 encoding of the string
// Formatted as: sha-256=:<base64-encoded-hash>:
async function get_digest(str) {
    var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(bytes)))}:`
}

// Makes sure the current state matches the digest in the update
async function check_digest(update, client_state) {
    if (update.extra_headers?.["repr-digest"]?.startsWith('sha-256=')
        && update.extra_headers["repr-digest"] !== await get_digest(client_state)) {
        console.log('repr-digest mismatch!')
        console.log('repr-digest: ' + update.extra_headers["repr-digest"])
        console.log('state: ' + client_state)
        throw new Error('repr-digest mismatch')
    }
}


// ── Text update parsing / serialization ────────────────────────────────

// Parse a wire update into text patches (with UTF-16 ranges)
function text_parse_update(update, client_state) {
    if (update.patches) {
        for (let patch of update.patches) {
            patch.range = patch.range.match(/\d+/g).map((x) => 1 * x)
            patch.content = patch.content_text
        }
        var patches = update.patches.sort((a, b) => a.range[0] - b.range[0])
        convert_ranges_codepoints_to_utf16(patches, client_state)
        return patches
    } else
        return [{range: [0, 0], content: update.body_text}]
}

// Prepare text patches for the wire (converts to code-point ranges,
// formats as simpleton text patches). Returns { patches, version_count }.
function text_prepare_put(patches, client_state) {
    convert_ranges_utf16_to_codepoints(patches, client_state)
    var version_count = 0
    for (let patch of patches) {
        version_count += patch.range[1] - patch.range[0]
        version_count += count_code_points(patch.content)
        patch.unit = "text"
        patch.range = `[${patch.range[0]}:${patch.range[1]}]`
    }
    return { patches, version_count }
}


// ── UI helpers ─────────────────────────────────────────────────────────

function set_acked_state(textarea, on = true) {
    if (on)
        textarea.style.caretColor = textarea.old_caretColor
    else {
        textarea.old_caretColor = textarea.style.caretColor
        textarea.style.caretColor = 'red'
    }
}

function set_error_state(textarea, on = true) {
    if (on) {
        textarea.old_disabled = textarea.disabled
        textarea.old_background = textarea.style.background
        textarea.old_border = textarea.style.border

        textarea.disabled = true
        textarea.style.background = '#fee'
        textarea.style.border = '4px solid red'
    } else {
        textarea.disabled = textarea.old_disabled
        textarea.style.background = textarea.old_background
        textarea.style.border = textarea.old_border
    }
}

// A convenient wrapper around the myers-diff.js library's "diff_main()" function,
// which is defined in https://braid.org/code/myers-diff1.js.
function diff(before, after) {
    let diff = diff_main(before, after)
    let patches = []
    let offset = 0
    for (let d of diff) {
        let p = null
        if (d[0] === 1) p = { range: [offset, offset], content: d[1] }
        else if (d[0] === -1) {
            p = { range: [offset, offset + d[1].length], content: "" }
            offset += d[1].length
        } else offset += d[1].length
        if (p) {
            p.unit = "text"
            patches.push(p)
        }
    }
    return patches
}

function apply_patches_and_update_selection(textarea, patches) {
    let offset = 0
    for (let p of patches) {
        p.range[0] += offset
        p.range[1] += offset
        offset -= p.range[1] - p.range[0]
        offset += p.content.length
    }

    let original = textarea.value
    let sel = [textarea.selectionStart, textarea.selectionEnd]

    for (var p of patches) {
        let range = p.range

        for (let i = 0; i < sel.length; i++)
            if (sel[i] > range[0])
                if (sel[i] > range[1]) sel[i] -= range[1] - range[0]
                else sel[i] = range[0]

        for (let i = 0; i < sel.length; i++) if (sel[i] > range[0]) sel[i] += p.content.length

        original = original.substring(0, range[0]) + p.content + original.substring(range[1])
    }

    textarea.value = original
    textarea.selectionStart = sel[0]
    textarea.selectionEnd = sel[1]
}
