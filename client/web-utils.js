
function set_acked_state(textarea, binary = true) {
    if (!binary) {
        textarea.old_caretColor = textarea.style.caretColor

        textarea.style.caretColor = 'red'
    } else {
        textarea.style.caretColor = textarea.old_caretColor
    }
}

function set_error_state(textarea, binary = true) {
    if (binary) {
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
