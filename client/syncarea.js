// ============================================================
// <synced-textarea> — a textarea wired to a braid-http resource
// ============================================================
//
// A drop-in replacement for <textarea> that stays in sync with a
// braid-http resource.
//
// Depends on braid-http-client.js, simpleton-sync.js, cursor-sync.js,
// textarea-highlights.js, and web-utils.js.
//
// Attributes:
//   src     — the URL to sync to
//   cursors — sync cursors too (default: true; set cursors="false" to disable)
//   bearer  — Bearer token for servers using "Authorization: Bearer X" headers
//
// The following attributes are relayed to the inner textarea:
//   placeholder, readonly, rows, cols, wrap, spellcheck, autofocus,
//   disabled, aria-label, aria-labelledby, aria-describedby
//
// Changes to src, cursors, or bearer restart the sync.
// Changes to any other attribute are just forwarded to the inner textarea.
//
// You can always manipulate the inner textarea directly via the .textarea property.


// Attributes in this list restart the sync when they change.
const CONNECTION_ATTRS = ['src', 'bearer', 'cursors']

// Attributes in this list are relayed straight to the inner textarea.
const FORWARD_ATTRS = ['placeholder', 'readonly', 'rows', 'cols',
                       'wrap', 'spellcheck', 'autofocus',
                       'aria-label', 'aria-labelledby', 'aria-describedby']


class SyncedTextarea extends HTMLElement {

    static observedAttributes = [...CONNECTION_ATTRS, ...FORWARD_ATTRS, 'disabled']

    // DOM lifecycle hooks — dispatched to the methods in the sections below.
    connectedCallback()    { this.connect() }
    disconnectedCallback() { this.disconnect() }
    attributeChangedCallback(name, oldValue, newValue) {
        if (!this.isConnected || oldValue === newValue) return
        if (CONNECTION_ATTRS.includes(name)) {
            this.disconnect()
            this.connect()
        } else if (name === 'disabled')
            this.update_disabled()
        else
            this.forward_attribute(name)
    }


    // ════════════════════════════════════════════════════════════
    //  Syncing the textarea
    // ════════════════════════════════════════════════════════════

    // Builds the inner textarea, wires up events, starts simpleton_client
    // and cursor_highlights if enabled.
    connect() {
        if (this.firstChild)
            console.warn('<synced-textarea> ignoring existing child content')
        while (this.firstChild) this.removeChild(this.firstChild)

        // Create the inner textarea, and fill the outer element with it.
        var textarea = document.createElement('textarea')
        textarea.style.width = '100%'
        textarea.style.height = '100%'
        textarea.style.boxSizing = 'border-box'
        this.appendChild(textarea)
        this.textarea = textarea

        // Mirror all pass-through attributes to the inner textarea.
        for (var attr of FORWARD_ATTRS) this.forward_attribute(attr)

        // Start disabled until we receive the first update from the server,
        // so the user can't type before we know what they're editing.
        this.waiting_for_first_update = true
        this.has_error = false
        this.update_disabled()

        // Re-dispatch the inner textarea's focus/blur events on the outer,
        // so listeners on <synced-textarea> see them.
        textarea.addEventListener('focus', () =>
            this.dispatchEvent(new FocusEvent('focus')))
        textarea.addEventListener('blur', () =>
            this.dispatchEvent(new FocusEvent('blur')))

        // When a <label for="x"> targets us, the browser fires a click on
        // us. Forward focus to the inner textarea.
        this.addEventListener('click', (e) => {
            if (e.target === this) textarea.focus()
        })

        // Nothing to sync if there's no src.
        var url = this.getAttribute('src')
        if (!url) return

        // Headers for all requests.
        var headers = {}
        var bearer = this.getAttribute('bearer')
        if (bearer) headers['Authorization'] = 'Bearer ' + bearer

        // Cursor sync defaults to on; set cursors="false" to disable.
        var cursors = this.getAttribute('cursors') !== 'false'
            ? cursor_highlights(textarea, url, { headers }) : null
        this.cursors = cursors

        // The main sync client.
        this.client = simpleton_client(url, {
            headers,
            on_online: (online) => { online ? cursors?.online() : cursors?.offline() },
            on_patches: (patches) => {
                this.waiting_for_first_update = false
                this.update_disabled()
                apply_patches_and_update_selection(textarea, patches)
                cursors?.on_patches(patches)
                this.dispatchEvent(new CustomEvent('remoteupdate', { detail: { patches } }))
                this.dispatchEvent(new CustomEvent('update',       { detail: { patches } }))
            },
            get_patches: (prev) => diff(prev, textarea.value),
            get_state:   () => textarea.value,
            on_error:    () => {
                this.has_error = true
                this.update_disabled()
                set_error_state(textarea)
            },
            on_ack:      () => set_acked_state(textarea)
        })

        // Local edits get relayed to the client and cursors.
        this.oninput_handler = () => {
            set_acked_state(textarea, false)
            var patches = this.client.changed()
            cursors?.on_edit(patches)
            this.dispatchEvent(new CustomEvent('update', { detail: { patches } }))
        }
        textarea.addEventListener('input', this.oninput_handler)
    }

    // Tear everything down.
    disconnect() {
        this.client?.abort()
        this.cursors?.destroy()
        if (this.textarea) {
            this.textarea.removeEventListener('input', this.oninput_handler)
            this.textarea.remove()
        }
        this.client = this.cursors = this.textarea = this.oninput_handler = null
        this.waiting_for_first_update = this.has_error = false
    }


    // ════════════════════════════════════════════════════════════
    //  Emulating an inner textarea with the outer sync-textarea
    // ════════════════════════════════════════════════════════════
    //  So code that works with a <textarea> works with us too — the
    //  same properties, methods, and events should behave identically.

    // Attribute forwarding — mirrors attrs from outer to inner textarea.
    forward_attribute(name) {
        if (!this.textarea) return
        if (this.hasAttribute(name))
            this.textarea.setAttribute(name, this.getAttribute(name))
        else
            this.textarea.removeAttribute(name)
    }

    // Effective disabled state = user's `disabled` attribute OR our own
    // internal state (still connecting, or erroring).
    update_disabled() {
        if (!this.textarea) return
        this.textarea.disabled = this.hasAttribute('disabled')
                              || this.waiting_for_first_update
                              || this.has_error
    }

    // Property forwarding — .value, .selectionStart, .selectionEnd, .selectionDirection.
    // Setting .value triggers client.changed() since textarea.value = ... doesn't fire
    // the 'input' event that our input listener relies on.
    get value()    { return this.textarea?.value ?? '' }
    set value(v)   {
        if (!this.textarea) return
        this.textarea.value = v
        this.client?.changed()
    }

    get selectionStart()      { return this.textarea?.selectionStart ?? 0 }
    set selectionStart(v)     { if (this.textarea) this.textarea.selectionStart = v }

    get selectionEnd()        { return this.textarea?.selectionEnd ?? 0 }
    set selectionEnd(v)       { if (this.textarea) this.textarea.selectionEnd = v }

    get selectionDirection()  { return this.textarea?.selectionDirection ?? 'none' }
    set selectionDirection(v) { if (this.textarea) this.textarea.selectionDirection = v }

    get textLength()          { return this.textarea?.textLength ?? 0 }

    // Scroll forwarding — the inner textarea is the scroll container.
    get scrollTop()           { return this.textarea?.scrollTop ?? 0 }
    set scrollTop(v)          { if (this.textarea) this.textarea.scrollTop = v }

    get scrollLeft()          { return this.textarea?.scrollLeft ?? 0 }
    set scrollLeft(v)         { if (this.textarea) this.textarea.scrollLeft = v }

    get scrollHeight()        { return this.textarea?.scrollHeight ?? 0 }
    get scrollWidth()         { return this.textarea?.scrollWidth ?? 0 }

    // Method forwarding — .focus(), .blur(), .select(), .setSelectionRange(), .setRangeText(),
    // .scrollTo(), .scrollBy().
    focus(options)            { this.textarea?.focus(options) }
    blur()                    { this.textarea?.blur() }
    select()                  { this.textarea?.select() }
    setSelectionRange(...a)   { this.textarea?.setSelectionRange(...a) }
    setRangeText(...a)        { this.textarea?.setRangeText(...a) }
    scrollTo(...a)            { this.textarea?.scrollTo(...a) }
    scrollBy(...a)            { this.textarea?.scrollBy(...a) }
}


customElements.define('synced-textarea', SyncedTextarea)
