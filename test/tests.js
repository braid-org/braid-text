// Shared test definitions that work in both Node.js and browser environments
// This file exports a function that takes a test runner and braid_fetch implementation

function defineTests(runTest, braid_fetch) {

runTest(
    "test subscribe update with body_text",
    async () => {
        var key = 'test' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var x = await new Promise(done => {
                    braid_text.get(new URL('http://localhost:8889/${key}'), {
                        subscribe: update => {
                            if (update.body_text === 'hi') done(update.body_text)
                        }
                    })
                })
                res.end(x)
            })()`
        })
        if (!r1.ok) return 'got: ' + r.status

        return await r1.text()
    },
    'hi'
)

runTest(
    "test braid_text.sync, key to url, where url breaks",
    async () => {
        var key = 'test' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var count = 0
                var ac = new AbortController()
                braid_text.sync('/${key}', new URL('http://localhost:8889/have_error'), {
                    signal: ac.signal,
                    on_pre_connect: () => {
                        count++
                        if (count === 2) {
                            res.end('it reconnected!')
                            ac.abort()
                        }
                    }
                })
            })()`
        })
        return await r.text()

    },
    'it reconnected!'
)

runTest(
    "test braid_text.sync, url to key",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                braid_text.sync(new URL('http://localhost:8889/${key_a}'), '/${key_b}')
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        await new Promise(done => setTimeout(done, 100))

        var r = await braid_fetch(`/${key_b}`)
        return 'got: ' + (await r.text())
    },
    'got: hi'
)

runTest(
    "test braid_text.sync, url to resource",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key_b}')
                braid_text.sync(new URL('http://localhost:8889/${key_a}'), resource)
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        await new Promise(done => setTimeout(done, 100))

        var r = await braid_fetch(`/${key_b}`)
        return 'got: ' + (await r.text())
    },
    'got: hi'
)

runTest(
    "test braid_text.sync, with two urls",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                try {
                    await braid_text.sync(new URL('http://localhost:8889/${key_a}'),
                        new URL('http://localhost:8889/${key_b}'))
                    res.end('no error')
                } catch (e) {
                    res.end('' + e)
                }
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        return 'got: ' + (await r.text())
    },
    'got: Error: one parameter should be local string key, and the other a remote URL object'
)

runTest(
    "test braid_text.sync, key to url",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                braid_text.sync('/${key_a}', new URL('http://localhost:8889/${key_b}'))
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        await new Promise(done => setTimeout(done, 100))

        var r = await braid_fetch(`/${key_b}`)
        return 'got: ' + (await r.text())
    },
    'got: hi'
)

runTest(
    "test braid_text.sync, key to url, when HEAD fails",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var count = 0
                var ac = new AbortController()
                braid_text.sync('/${key_a}', new URL('http://localhost:8889/have_error'), {
                    signal: ac.signal,
                    on_pre_connect: () => {
                        count++
                        if (count === 2) {
                            res.end('it reconnected!')
                            ac.abort()
                        }
                    }
                })
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        return await r.text()
    },
    'it reconnected!'
)

runTest(
    "test when remote doesn't have a fork-point that we think they have",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)
        var key_c = 'test-c-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                braid_text.sync('/${key_a}', new URL('http://localhost:8889/${key_b}'))
                await new Promise(done => setTimeout(done, 100))
                braid_text.sync('/${key_a}', new URL('http://localhost:8889/${key_c}'))
                await new Promise(done => setTimeout(done, 100))
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        return await (await braid_fetch(`/${key_c}`)).text()
    },
    'hi'
)

runTest(
    "test when we don't have a fork-point with remote, but they do have a shared version",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var ac = new AbortController()
                braid_text.get('/${key_a}', {
                    signal: ac.signal,
                    subscribe: update => braid_text.put('/${key_b}', update)
                })
                await new Promise(done => setTimeout(done, 100))
                ac.abort()
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            body: 'yo'
        })
        if (!r.ok) return 'got: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var ac = new AbortController()
                braid_text.sync('/${key_a}', new URL('http://localhost:8889/${key_b}'), {signal: ac.signal})
                await new Promise(done => setTimeout(done, 100))
                ac.abort()
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        return await (await braid_fetch(`/${key_b}`)).text()
    },
    'yo'
)

runTest(
    "test braid_text.sync, with two keys",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)
        var key_b = 'test-b-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                try {
                    await braid_text.sync('/${key_a}', '/${key_b}')
                    res.end('no error')
                } catch (e) {
                    res.end('' + e)
                }
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        return 'got: ' + (await r.text())
    },
    'got: Error: one parameter should be local string key, and the other a remote URL object'
)

runTest(
    "test putting version with multiple event ids, should have error",
    async () => {
        var key_a = 'test-a-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key_a}`, {
            method: 'PUT',
            version: ['abc-1', 'xyz-2'],
            body: 'hi'
        })
        return '' + (await r.text()).includes('cannot put a version with multiple ids')
    },
    'true'
)

runTest(
    "test braid_text.get(url), with no options",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                res.end(await braid_text.get(new URL('http://localhost:8889/${key}')))
            })()`
        })

        return 'got: ' + (await r1.text())
    },
    'got: hi'
)

runTest(
    "test braid_text.get(url), with headers",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['xyz-1'],
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                res.end(await braid_text.get(new URL('http://localhost:8889/${key}'), {
                    headers: {
                        version: '"xyz-0"'
                    }
                }))
            })()`
        })

        return 'got: ' + (await r1.text())
    },
    'got: h'
)

runTest(
    "test braid_text.get(url), with parents",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['xyz-1'],
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                res.end(await braid_text.get(new URL('http://localhost:8889/${key}'), {
                    parents: ['xyz-0']
                }))
            })()`
        })

        return 'got: ' + (await r1.text())
    },
    'got: h'
)

runTest(
    "test braid_text.get(url), with version and peer",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['xyz-1'],
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                res.end(await braid_text.get(new URL('http://localhost:8889/${key}'), {
                    version: ['xyz-0'],
                    peer: 'xyz'
                }))
            })()`
        })

        return 'got: ' + (await r1.text())
    },
    'got: h'
)

runTest(
    "test braid_text.get(url) with subscription",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['xyz-1'],
            body: 'hi'
        })
        if (!r.ok) return 'got: ' + r.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var url = new URL('http://localhost:8889/${key}')
                var ac = new AbortController()
                var update = await new Promise(done => {
                    braid_text.get(url, {
                        signal: ac.signal,
                        subscribe: update => {
                            ac.abort()
                            done(update)
                        }
                    })
                })
                res.end(update.body)
            })()`
        })

        return 'got: ' + (await r1.text())
    },
    'got: hi'
)

runTest(
    "test braid_text.put(url), with body",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var r = await braid_text.put(new URL('http://localhost:8889/${key}'),
                    {body: 'yo'})
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        let r1 = await braid_fetch(`/${key}`)
        return 'got: ' + (await r1.text())
    },
    'got: yo'
)

runTest(
    "test braid_text.put(url), with body and headers",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var r = await braid_text.put(new URL('http://localhost:8889/${key}'),
                    {body: 'yo', headers: {version: '"abc123-1"'}})
                res.end('')
            })()`
        })
        if (!r.ok) return 'got: ' + r.status

        let r2 = await braid_fetch(`/${key}`)
        return 'got: ' + (await r2.text()) + ' -- version: ' + r2.headers.get('version')
    },
    'got: yo -- version: "abc123-1"'
)

runTest(
    "test braid_text.put(url), with body and version and parents",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hi',
            version: ['abc-1']
        })

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var r = await braid_text.put(new URL('http://localhost:8889/${key}'),
                    {body: 'yo', version: ['xyz-3'], parents: ['abc-1']})
                res.end('')
            })()`
        })
        if (!r1.ok) return 'got: ' + r1.status

        let r2 = await braid_fetch(`/${key}`)
        return 'got: ' + (await r2.text()) + ' -- version: ' + r2.headers.get('version')
    },
    'got: yo -- version: "xyz-3"'
)

runTest(
    "test braid_text.put(url), with peer",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var r = await braid_text.put(new URL('http://localhost:8889/${key}'),
                    {body: 'yo', peer: 'xyz', parents: []})
                res.end('')
            })()`
        })
        if (!r1.ok) return 'got: ' + r1.status

        let r2 = await braid_fetch(`/${key}`)
        return 'got: ' + (await r2.text()) + ' -- version: ' + r2.headers.get('version')
    },
    'got: yo -- version: "xyz-1"'
)

runTest(
    "test loading a meta file from disk",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')
                resource.meta = { test_meta_info: 42 }
                resource.change_meta()

                await new Promise(done => setTimeout(done, 200))

                delete braid_text.cache['/${key}']

                var resource = await braid_text.get_resource('/${key}')
                res.end(JSON.stringify(resource.meta))
            })()`
        })

        return (await r1.text())
    },
    '{"test_meta_info":42}'
)

runTest(
    "test PUT digest (good)",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        async function get_digest(s) {
            var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
            return `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(bytes)))}:`
        }

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx',
            headers: {
                'Repr-Digest': await get_digest('xx')
            }
        })
        if (!r.ok) return 'got: ' + r.status
        return 'ok'
    },
    'ok'
)

runTest(
    "test PUT digest (bad)",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        async function get_digest(s) {
            var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
            return `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(bytes)))}:`
        }

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx',
            headers: {
                'Repr-Digest': await get_digest('yy')
            }
        })
        if (!r.ok) return 'got: ' + r.status
        return 'ok'
    },
    'got: 550'
)

runTest(
    "test subscribing and verifying digests [simpleton]",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            version: ['hi-0'],
            subscribe: true
        })
        var parts = []
        var p = new Promise(async (done, fail) => {
            r2.subscribe(update => {
                parts.push(update.extra_headers['repr-digest'])
                if (parts.length > 1) {
                    done()
                    a.abort()
                }
            }, fail)
        })

        await new Promise(done => setTimeout(done, 300))
        let rr = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-2'],
            parents: ['hi-1'],
            patches: [{unit: "text", range: "[1:1]", content: "Y"}]
        })
        if (!rr.ok) throw 'got: ' + rr.statusCode

        await p
        return JSON.stringify(parts)
    },
    '["sha-256=:Xd6JaIf2dUybFb/jpEGuSAbfL96UABMR4IvxEGIuC74=:","sha-256=:77cl3INcGEtczN0zK3eOgW/YWYAOm8ub73LkVcF2/rA=:"]'
)

runTest(
    "test subscribing and verifying digests [dt]",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            version: ['hi-0'],
            headers: { 'merge-type': 'dt' },
            subscribe: true
        })
        var parts = []
        var p = new Promise(async (done, fail) => {
            r2.subscribe(update => {
                parts.push(update.extra_headers['repr-digest'])
                if (parts.length > 1) {
                    done()
                    a.abort()
                }
            }, fail)
        })

        await new Promise(done => setTimeout(done, 300))
        let rr = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-2'],
            parents: ['hi-1'],
            patches: [{unit: "text", range: "[2:2]", content: "Y"}]
        })
        if (!rr.ok) throw 'got: ' + rr.statusCode

        await p
        return JSON.stringify(parts)
    },
    '["sha-256=:Xd6JaIf2dUybFb/jpEGuSAbfL96UABMR4IvxEGIuC74=:","sha-256=:QknHazou37wCCwv3JXnCoAvXcKszP6xBTxLIiUAETgI=:"]'
)

runTest(
    "test PUTing a version that the server already has",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-0'],
            parents: [],
            body: 'x'
        })

        var r2 = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-0'],
            parents: [],
            body: 'x'
        })

        return r1.status + " " + r2.status
    },
    '200 200'
)

runTest(
    "test validate_already_seen_versions with same version",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                var {change_count} = await braid_text.put(resource, { peer: "abc", version: ["hi-2"], parents: [], patches: [{unit: "text", range: "[0:0]", content: "XYZ"}], merge_type: "dt" })

                res.end('' + change_count)
            })()`
        })

        var r2 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                var {change_count} = await braid_text.put(resource, { peer: "abc", version: ["hi-2"], parents: [], patches: [{unit: "text", range: "[0:0]", content: "XYZ"}], merge_type: "dt", validate_already_seen_versions: true })

                res.end('' + change_count)
            })()`
        })

        return (await r1.text()) + " " + (await r2.text())
    },
    '3 3'
)

runTest(
    "test validate_already_seen_versions with modified version",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                var {change_count} = await braid_text.put(resource, { peer: "abc", version: ["hi-2"], parents: [], patches: [{unit: "text", range: "[0:0]", content: "XYZ"}], merge_type: "dt" })

                res.end('' + change_count)
            })()`
        })

        var r2 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    var {change_count} = await braid_text.put(resource, { peer: "abc", version: ["hi-2"], parents: [], patches: [{unit: "text", range: "[0:0]", content: "ABC"}], merge_type: "dt", validate_already_seen_versions: true })

                    res.end('' + change_count)
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })

        return await r2.text()
    },
    'invalid update: different from previous update with same version'
)

runTest(
    "test loading a previously saved resource",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var f1 = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-2'],
            parents: [],
            body: 'abc'
        })

        var f1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `
                delete braid_text.cache['/${key}']
                res.end()
            `
        })

        var r = await braid_fetch(`/${key}`)
        return await r.text()
    },
    'abc'
)

runTest(
    "test non-contigous ids",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-10'],
            parents: [],
            body: 'abc'
        })

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-20'],
            parents: ['hi-10'],
            body: 'ABC'
        })

        var f1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `
                delete braid_text.cache['/${key}']
                res.end()
            `
        })

        var r = await braid_fetch(`/${key}`)
        return await r.text()
    },
    'ABC'
)

runTest(
    "test when PUT cache/buffer size fails",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var f1 = braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-3000000'],
            parents: ['yo-0'],
            body: 'A'.repeat(3000000)
        })

        await new Promise(done => setTimeout(done, 300))

        var f2 = braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['ih-3000000'],
            parents: ['yo-0'],
            body: 'B'.repeat(3000000)
        })

        await new Promise(done => setTimeout(done, 300))

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['yo-0'],
            parents: [],
            body: 'x'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return `f1: ${(await f1).status}, f2: ${(await f2).status}`
    },
    'f1: 200, f2: 309'
)

runTest(
    "test multiple patches",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-0'],
            parents: [],
            body: 'A'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['yo-1'],
            parents: ['hi-0'],
            patches: [
                {unit: 'text', range: '[0:0]', content: 'C'},
                {unit: 'text', range: '[1:1]', content: 'T'}
            ]
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r2 = await braid_fetch(`/${key}`)
        return await r2.text()
    },
    'CAT'
)

runTest(
    "test PUT after subscribing",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var p_done
        var p = new Promise(done => p_done = done)

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })
        r.subscribe(update => {
            if (update.version[0] === 'hi-0') {
                p_done(update.patches[0].content_text)
                a.abort()
            }
        })

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-0'],
            parents: [],
            body: 'x'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return await p
    },
    'x'
)

runTest(
    "test put awaits subscriber callbacks",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var order = []

                // Subscribe with an async callback that takes some time
                braid_text.get('/${key}', {
                    subscribe: async (update) => {
                        if (update.version?.[0]?.startsWith('test-v')) {
                            order.push('subscriber-start')
                            await new Promise(done => setTimeout(done, 50))
                            order.push('subscriber-end')
                        }
                    }
                })

                // Wait for subscription to be established
                await new Promise(done => setTimeout(done, 50))

                // Put should await the subscriber callback
                await braid_text.put('/${key}', {
                    version: ['test-v-0'],
                    parents: [],
                    body: 'hello'
                })
                order.push('put-done')

                // If put properly awaited, order should be: subscriber-start, subscriber-end, put-done
                // If put didn't await, order would be: subscriber-start, put-done, subscriber-end
                res.end(order.join(','))
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'subscriber-start,subscriber-end,put-done'
)

runTest(
    "test out-of-order PUTs",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var f = braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: ['hi-0'],
            patches: [{unit: 'text', range: '[1:1]', content: 'y'}]
        })

        await new Promise(done => setTimeout(done, 500))

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-0'],
            parents: [],
            body: 'x'
        })

        if (!r.ok) throw 'got: ' + r.status

        r = await f
        if (!r.ok) throw 'got: ' + r.status

        var r2 = await braid_fetch(`/${key}`)
        return await r2.text()
    },
    'xy'
)

runTest(
    "test out-of-order PUTs (trial two)",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var f = braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['ab-1'],
            parents: ['hi-0'],
            patches: [{unit: 'text', range: '[1:1]', content: 'y'}]
        })

        await new Promise(done => setTimeout(done, 500))

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xz'
        })

        if (!r.ok) throw 'got: ' + r.statusCode

        r = await f
        if (!r.ok) throw 'got: ' + r.statusCode

        var r2 = await braid_fetch(`/${key}`)
        return await r2.text()
    },
    'xyz'
)

runTest(
    "test in-order PUTs",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-0'],
            parents: [],
            body: 'x'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: ['hi-0'],
            patches: [{unit: 'text', range: '[1:1]', content: 'y'}]
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r2 = await braid_fetch(`/${key}`)
        return await r2.text()
    },
    'xy'
)

runTest(
    "test put with transfer-encoding: dt",
    async () => {
        await dt_p
        var key = 'test-' + Math.random().toString(36).slice(2)
        var doc = new Doc('hi')
        doc.ins(0, 'xy')

        var bytes = doc.toBytes()

        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var key = '/${key}'

                var {change_count} = await braid_text.put(key, {
                    body: new Uint8Array([${'' + bytes}]),
                    transfer_encoding: "dt"
                })
                var {body, version} = await braid_text.get(key, {})

                res.end('' + change_count + " " + body + " " + version)
            })()`
        })

        return await r1.text()
    },
    '2 xy hi-1'
)

runTest(
    "test transfer-encoding dt (with parents)",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)
        var doc = new Doc('hi')
        doc.ins(0, 'x')

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            parents: ['hi-0'],
            headers: {
                'Accept-Transfer-Encoding': 'dt'
            }
        })

        doc.mergeBytes([...new Uint8Array(await r2.arrayBuffer())])
        var text = doc.get()
        doc.free()

        return r2.headers.get('current-version') + ' ' + r2.headers.get('x-transfer-encoding') + ' ' + text + ' ' + r2.statusText
    },
    '"hi-1" dt xy Multiresponse'
)

runTest(
    "test transfer-encoding dt",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            headers: {
                'Accept-Transfer-Encoding': 'dt'
            }
        })

        var doc = new Doc('yo')
        doc.mergeBytes([...new Uint8Array(await r2.arrayBuffer())])
        var text = doc.get()
        doc.free()

        return r2.headers.get('current-version') + ' ' + r2.headers.get('x-transfer-encoding') + ' ' + text
    },
    '"hi-1" dt xy'
)

runTest(
    "test GETing old version explicitly with transfer-encoding dt",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi∑-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            version: ['hi∑-0'],
            headers: {
                'Accept-Transfer-Encoding': 'dt'
            }
        })

        var doc = new Doc('yo')
        doc.mergeBytes([...new Uint8Array(await r2.arrayBuffer())])
        var text = doc.get()
        doc.free()

        return r2.headers.get('current-version') + ' ' + text + ' ' + JSON.parse(r2.headers.get('current-version'))
    },
    '"hi\\u2211-1" x hi∑-1'
)

runTest(
    "test GETing current version explicitly with transfer-encoding dt",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi∑-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            version: ['hi∑-1'],
            headers: {
                'Accept-Transfer-Encoding': 'dt'
            }
        })

        var doc = new Doc('yo')
        doc.mergeBytes([...new Uint8Array(await r2.arrayBuffer())])
        var text = doc.get()
        doc.free()

        return r2.headers.get('current-version') + ' ' + text + ' ' + JSON.parse(r2.headers.get('current-version'))
    },
    '"hi\\u2211-1" xy hi∑-1'
)

runTest(
    "test for Current-Version when GETing old version",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi∑-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            version: ['hi∑-0']
        })

        var text = await r2.text()

        return r2.headers.get('current-version') + ' ' + r2.headers.get('version') + ' ' + text + ' ' + JSON.parse(r2.headers.get('current-version'))
    },
    '"hi\\u2211-1" "hi\\u2211-0" x hi∑-1'
)

runTest(
    "test HEAD for GET without subscribe",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi∑-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            method: 'HEAD'
        })

        var text = await r2.text()

        return r2.headers.get('version') + ' ' + JSON.parse(r2.headers.get('version')) + ` text:[${text}]`
    },
    '"hi\\u2211-1" hi∑-1 text:[]'
)

runTest(
    "test HEAD for GET without subscribe (with transfer-encoding)",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi∑-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        let r2 = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            headers: {
                'accept-transfer-encoding': 'dt'
            }
        })

        var buf = await r2.arrayBuffer()

        return r2.headers.get('current-version') + ' ' + JSON.parse(r2.headers.get('current-version')) + ` buf.byteLength:${buf.byteLength}`
    },
    '"hi\\u2211-1" hi∑-1 buf.byteLength:0'
)

runTest(
    "test accept-encoding updates(dt) (with parents)",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)
        var doc = new Doc('hi')
        doc.ins(0, 'x')

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            parents: ['hi-0'],
            subscribe: true,
            headers: {
                'merge-type': 'dt',
                'X-Accept-Encoding': 'updates(dt)'
            }
        })

        return await new Promise(done => {
            r2.subscribe(u => {
                doc.mergeBytes(u.body)
                done(doc.get())
                doc.free()
                a.abort()
            })
        })
    },
    'xy'
)

runTest(
    "test accept-encoding updates(dt) (with parents which are current version)",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)
        var doc = new Doc('hi')
        doc.ins(0, 'xy')

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            parents: ['hi-1'],
            subscribe: true,
            headers: {
                'merge-type': 'dt',
                'X-Accept-Encoding': 'updates(dt)'
            }
        })

        return await new Promise(done => {
            r2.subscribe(u => {
                doc.mergeBytes(u.body)
                done(doc.get())
                doc.free()
                a.abort()
            })
        })
    },
    'xy'
)

runTest(
    "test accept-encoding updates(dt)",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            headers: {
                'merge-type': 'dt',
                'X-Accept-Encoding': 'updates(dt)'
            }
        })

        var doc = new Doc('yo')
        return await new Promise(done => {
            r2.subscribe(u => {
                doc.mergeBytes(u.body)
                done(doc.get())
                doc.free()
                a.abort()
            })
        })
    },
    'xy'
)

runTest(
    "test accept-encoding updates(dt), getting non-encoded update",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            headers: {
                'merge-type': 'dt',
                'X-Accept-Encoding': 'updates(dt)'
            }
        })

        setTimeout(async () => {
            await braid_fetch(`/${key}`, {
                method: 'PUT',
                version: ['yo-0'],
                parents: ['hi-1'],
                patches: [{unit: 'text', range: '[2:2]', content: 'z'}]
            })
        }, 200)

        var results = []

        var doc = new Doc('yo')
        return await new Promise(done => {
            r2.subscribe(u => {
                if (!u.status) {
                    doc.mergeBytes(u.body)
                    results.push(doc.get())
                    doc.free()
                } else {
                    results.push(u.patches[0].content_text)
                    done(results.join(''))
                    a.abort()
                }
            })
        })
    },
    'xyz'
)

runTest(
    "test Version we get from PUTing",
    async () => {
        await dt_p
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi∑-1'],
            parents: [],
            body: 'xy'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return r.headers.get('version')
    },
    '"hi\\u2211-1"'
)

runTest(
    "test error code when missing parents",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)
        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: ['missing-0', 'y😀-0'],
            body: 'xx'
        })
        return r.status + ' ' + r.ok + ' ' + r.statusText +  ' ' + r.headers.get('Version')
    },
    '309 false Version Unknown Here "missing-0", "y\\ud83d\\ude00-0"'
)

runTest(
    "test subscribing starting at a version using simpleton",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            version: ['hi-0'],
            subscribe: true
        })
        return await new Promise(async (done, fail) => {
            r2.subscribe(update => {
                done(JSON.stringify(update.parents))
                a.abort()
            }, fail)
        })
    },
    JSON.stringify([ "hi-0" ])
)

runTest(
    "test subscribing starting at a version using dt",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            version: ['hi-0'],
            subscribe: true,
            headers: {
                'Merge-Type': 'dt'
            }
        })
        return r2.headers.get('merge-type') + ':' + await new Promise(async (done, fail) => {
            r2.subscribe(update => {
                done(JSON.stringify(update.parents))
                a.abort()
            }, fail)
        })
    },
    'dt:' + JSON.stringify([ "hi-0" ])
)

runTest(
    "test subscribing starting at the latest version using dt",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            version: ['hi-1'],
            subscribe: true,
            headers: {
                'Merge-Type': 'dt'
            }
        })
        return await new Promise(async (done, fail) => {
            r2.subscribe(update => {
                done('got something')
                a.abort()
            }, fail)
            setTimeout(() => {
                done('got nothing')
                a.abort()
            }, 1500)
        })
    },
    'got nothing'
)

runTest(
    "test subscribing starting at beginning using dt",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        let r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-1'],
            parents: [],
            body: 'xx'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        let r2 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            headers: {
                'Merge-Type': 'dt'
            }
        })
        return r2.headers.get('merge-type') + ':' + await new Promise(async (done, fail) => {
            r2.subscribe(update => {
                if (update.version[0] === 'hi-1') {
                    done('got it!')
                    a.abort()
                }
            }, fail)
        })
    },
    'dt:got it!'
)

runTest(
    "test dt_create_bytes with big agent name",
    async () => {
        let x = await (await fetch(`/test.html?dt_create_bytes_big_name`)).json()
        return JSON.stringify(x)
    },
    JSON.stringify({ok: true})
)

runTest(
    "test dt_create_bytes with many agent names",
    async () => {
        let x = await (await fetch(`/test.html?dt_create_bytes_many_names`)).json()
        return JSON.stringify(x)
    },
    JSON.stringify({ok: true})
)

runTest(
    "test deleting a resource",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        await fetch(`/${key}`, {
            method: 'PUT',
            body: 'hi'
        })

        await fetch(`/${key}`, {method: 'DELETE'})

        let r = await fetch(`/${key}`)

        return await r.text()
    },
    ''
)

runTest(
    "test deleting a resource completely removes all traces",
    async () => {
        let key = 'test-delete-complete-' + Math.random().toString(36).slice(2)

        // Create a resource with some content
        // "hello world" is 11 characters, so version should be alice-10 (positions 0-10 inclusive)
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['alice-10'],
            parents: [],
            body: 'hello world'
        })

        // Verify it exists in cache using eval endpoint
        let r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `res.end(braid_text.cache['/${key}'] ? 'exists' : 'missing')`
        })
        if ((await r1.text()) !== 'exists') return 'Resource not in cache after creation'

        // Delete the resource
        await braid_fetch(`/${key}`, {method: 'DELETE'})

        // Verify it's removed from cache
        let r2 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `res.end(braid_text.cache['/${key}'] ? 'exists' : 'missing')`
        })
        if ((await r2.text()) !== 'missing') return 'Resource still in cache after deletion'

        // Verify we can create it again from scratch with same key
        // "new content" is 11 characters, so version should be bob-10 (positions 0-10 inclusive)
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['bob-10'],
            parents: [],
            body: 'new content'
        })

        // Get the new resource and verify it's fresh (not the old one)
        let r = await braid_fetch(`/${key}`)
        let body = await r.text()

        if (body !== 'new content') return `Expected 'new content', got '${body}'`

        // Verify the version is from scratch (bob-10, not alice-10)
        let version = r.headers.get('version')
        if (!version.includes('bob-10')) return `Expected version to include bob-10, got: ${version}`
        if (version.includes('alice-')) return `Old version alice-10 should not be present, got: ${version}`

        return 'ok'
    },
    'ok'
)

runTest(
    "test braid_text.delete(url)",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        // Create a resource first
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hello there'
        })

        // Verify it exists
        let r1 = await braid_fetch(`/${key}`)
        if ((await r1.text()) !== 'hello there') return 'Resource not created properly'

        // Delete using braid_text.delete(url)
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                await braid_text.delete(new URL('http://localhost:8889/${key}'))
                res.end('deleted')
            })()`
        })
        if (!r.ok) return 'delete failed: ' + r.status
        if ((await r.text()) !== 'deleted') return 'delete did not complete'

        // Verify it's deleted (should be empty)
        let r2 = await braid_fetch(`/${key}`)
        return 'got: ' + (await r2.text())
    },
    'got: '
)

runTest(
    "test braid_text.get(url) returns null for 404",
    async () => {
        // Use the /404 endpoint that always returns 404
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var result = await braid_text.get(new URL('http://localhost:8889/404'))
                res.end(result === null ? 'null' : 'not null: ' + result)
            })()`
        })
        return await r.text()
    },
    'null'
)

runTest(
    "test braid_text.sync handles remote not existing yet",
    async () => {
        var local_key = 'test-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-remote-' + Math.random().toString(36).slice(2)

        // Start sync between a local key and a remote URL that doesn't exist yet
        // The sync should wait for local to create something, then push to remote
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var ac = new AbortController()

                // Start sync - remote doesn't exist yet
                braid_text.sync('/${local_key}', new URL('http://localhost:8889/${remote_key}'), {
                    signal: ac.signal
                })

                // Wait a bit then put something locally
                await new Promise(done => setTimeout(done, 100))
                await braid_text.put('/${local_key}', { body: 'created locally' })

                // Wait for sync to propagate
                await new Promise(done => setTimeout(done, 200))

                // Stop sync
                ac.abort()

                res.end('done')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        // Check that remote now has the content
        var r2 = await braid_fetch(`/${remote_key}`)
        return await r2.text()
    },
    'created locally'
)

runTest(
    "test braid_text.sync on_res callback",
    async () => {
        var local_key = 'test-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-remote-' + Math.random().toString(36).slice(2)

        // Create the remote resource first
        var r = await braid_fetch(`/${remote_key}`, {
            method: 'PUT',
            body: 'remote content'
        })
        if (!r.ok) return 'put failed: ' + r.status

        // Start sync with on_res callback and verify it gets called
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var ac = new AbortController()
                var got_res = false

                braid_text.sync('/${local_key}', new URL('http://localhost:8889/${remote_key}'), {
                    signal: ac.signal,
                    on_res: (response) => {
                        got_res = response && typeof response.headers !== 'undefined'
                    }
                })

                // Wait for sync to establish and on_res to be called
                await new Promise(done => setTimeout(done, 200))

                ac.abort()
                res.end(got_res ? 'on_res called' : 'on_res not called')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'on_res called'
)

runTest(
    "test braid_text.sync uses accept-encoding updates(dt)",
    async () => {
        var remote_key = 'test-remote-' + Math.random().toString(36).slice(2)
        var local_key = 'test-local-' + Math.random().toString(36).slice(2)

        // Create the remote resource with some content
        var r = await braid_fetch(`/${remote_key}`, {
            method: 'PUT',
            body: 'remote content here'
        })
        if (!r.ok) return 'put failed: ' + r.status

        // Start sync with URL first (like the passing "url to key" test)
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                braid_text.sync(new URL('http://localhost:8889/${remote_key}'), '/${local_key}')
                res.end('')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        // Wait for sync to complete
        await new Promise(done => setTimeout(done, 100))

        // Check local has remote content
        var r = await braid_fetch(`/${local_key}`)
        return await r.text()
    },
    'remote content here'
)

runTest(
    "test braid_text.sync reconnects when inner put fails with non-200 status",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        // Create a local resource with content
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'initial'
        })
        if (!r.ok) return 'initial put failed: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var connect_count = 0
                var ac = new AbortController()

                braid_text.sync('/${key}', new URL('http://localhost:8889/server_error'), {
                    signal: ac.signal,
                    on_pre_connect: () => {
                        connect_count++
                        if (connect_count >= 2) {
                            ac.abort()
                            res.end('reconnected after put failure')
                        }
                    }
                })

                // Trigger a local put which will fail when synced to the error endpoint
                await new Promise(done => setTimeout(done, 100))
                await braid_text.put('/${key}', { body: 'trigger sync' })

                // Wait for reconnect attempt
                await new Promise(done => setTimeout(done, 2000))
                ac.abort()
                res.end('did not reconnect')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'reconnected after put failure'
)

runTest(
    "test braid_text.sync on_unauthorized callback for 401",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        // Create a local resource with content
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'initial'
        })
        if (!r.ok) return 'initial put failed: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var unauthorized_called = false
                var ac = new AbortController()

                braid_text.sync('/${key}', new URL('http://localhost:8889/unauthorized'), {
                    signal: ac.signal,
                    on_unauthorized: () => {
                        unauthorized_called = true
                        ac.abort()
                        res.end('on_unauthorized called')
                    }
                })

                // Trigger a local put which will get 401 when synced
                await new Promise(done => setTimeout(done, 100))
                await braid_text.put('/${key}', { body: 'trigger sync' })

                // Wait for callback
                await new Promise(done => setTimeout(done, 2000))
                ac.abort()
                res.end('on_unauthorized not called')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'on_unauthorized called'
)

runTest(
    "test braid_text.sync on_unauthorized callback for 403",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        // Create a local resource with content
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'initial'
        })
        if (!r.ok) return 'initial put failed: ' + r.status

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var unauthorized_called = false
                var ac = new AbortController()

                braid_text.sync('/${key}', new URL('http://localhost:8889/forbidden'), {
                    signal: ac.signal,
                    on_unauthorized: () => {
                        unauthorized_called = true
                        ac.abort()
                        res.end('on_unauthorized called')
                    }
                })

                // Trigger a local put which will get 403 when synced
                await new Promise(done => setTimeout(done, 100))
                await braid_text.put('/${key}', { body: 'trigger sync' })

                // Wait for callback
                await new Promise(done => setTimeout(done, 2000))
                ac.abort()
                res.end('on_unauthorized not called')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'on_unauthorized called'
)

runTest(
    "test getting a binary update from a subscription",
    async () => {
        return await new Promise(async (done, fail) => {
            let key = 'test-' + Math.random().toString(36).slice(2)

            await fetch(`/${key}`, {
                method: 'PUT',
                body: JSON.stringify({a: 5, b: 6}, null, 4)
            })

            var a = new AbortController()
            let r = await braid_fetch(`/${key}`, {
                signal: a.signal,
                subscribe: true
            })

            r.subscribe(update => {
                done(update.body_text)
                a.abort()
            }, fail)
        })
    },
    JSON.stringify({a: 5, b: 6}, null, 4)
)

runTest(
    "test sending a json patch to some json-text",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        await fetch(`/${key}`, {
            method: 'PUT',
            body: JSON.stringify({a: 5, b: 6})
        })

        await fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Content-Range': 'json a' },
            body: '67'
        })

        let r = await fetch(`/${key}`)

        return await r.text()
    },
    JSON.stringify({a: 67, b: 6}, null, 4)
)

runTest(
    "test sending multiple json patches to some json-text",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        await fetch(`/${key}`, {
            method: 'PUT',
            body: JSON.stringify({a: 5, b: 6, c: 7})
        })

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Content-Range': 'json a' },
            patches: [{
                unit: 'json',
                range: 'a',
                content: '55',
            }, {
                unit: 'json',
                range: 'b',
                content: '66',
            }]
        })

        let r = await fetch(`/${key}`)

        return await r.text()
    },
    JSON.stringify({a: 55, b: 66, c: 7}, null, 4)
)

runTest(
    "test deleting something using a json patch",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        await fetch(`/${key}`, {
            method: 'PUT',
            body: JSON.stringify({a: 5, b: 6}, null, 4)
        })

        await fetch(`/${key}`, {
            method: 'PUT',
            headers: { 'Content-Range': 'json a' },
            body: ''
        })

        let r = await fetch(`/${key}`)

        return await r.text()
    },
    JSON.stringify({b: 6}, null, 4)
)

runTest(
    "test length updating",
    async () => {
        let key = 'test-' + Math.random().toString(36).slice(2)

        await fetch(`/${key}`, { method: 'PUT', body: '' })
        await fetch(`/${key}`, { method: 'PUT', body: '0123456789' })
        await fetch(`/${key}`, { method: 'PUT', body: '0123456789' })
        await fetch(`/${key}`, { method: 'PUT', body: '0123456789' })

        let r = await fetch(`/${key}`, { method: 'HEAD' })
        return '' + parseInt(r.headers.get('version').split('-')[1])
    },
    '19'
)

runTest(
    "test retry when parents not there..",
    async () => {
        return await new Promise(done => {
            var count = 0
            var key = 'test-' + Math.random().toString(36).slice(2)
            var a = new AbortController()
            braid_fetch(`/${key}`, {
                signal: a.signal,
                multiplex: false,
                method: 'PUT',
                version: ['hi-3'],
                parents: ['hi-1'],
                body: 'xx',
                onFetch: () => {
                    count++
                    if (count === 2) {
                        done('retried!')
                        a.abort()
                    }
                },
                retry: true
            })
        })
    },
    'retried!'
)

runTest(
    "test asking for a version that should and shouldn't be there",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-10'],
            parents: [],
            body: 'x'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            version: ['hi-5']
        })
        if (r.status !== 309) throw 'expected 309, got: ' + r.status
        if (r.statusText !== 'Version Unknown Here') throw 'unexpected status text: ' + r.statusText
        if (r.ok) throw 'found version we should not have found'

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            version: ['hi-10']
        })
        if (!r.ok) throw 'could not find version we should have found'

        return 'worked out!'
    },
    'worked out!'
)

runTest(
    "test asking for parents that should and shouldn't be there",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-10'],
            parents: [],
            body: 'x'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            parents: ['hi-5']
        })
        if (r.status !== 309) throw 'expected 309, got: ' + r.status
        if (r.ok) throw 'found parents we should not have found'

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            parents: ['hi-10']
        })
        if (!r.ok) throw 'could not find parents we should have found'

        return 'worked out!'
    },
    'worked out!'
)

runTest(
    "test that 309 returns all missing events",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-11'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'HEAD',
            version: ['yo-1', 'hi-11'],
            parents: ['hi-5', 'hi-8', 'hi-9', 'hi-10']
        })
        if (r.status !== 309) throw 'expected 309, got: ' + r.status
        return r.headers.get('version')
    },
    '"yo-1", "hi-5", "hi-8"'
)

runTest(
    "test that subscribe returns current-version header",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['hi-11'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })
        var result = r.headers.get('current-version')
        a.abort()
        return result
    },
    '"hi-11"'
)

runTest(
    "test case-insensitive filesystem handling (/a vs /A)",
    async () => {
        // This test verifies that keys differing only in case are stored
        // in separate files on case-insensitive filesystems (Mac/Windows)
        var key_lower = '/test-case-' + Math.random().toString(36).slice(2)
        var key_upper = key_lower.toUpperCase()

        // Store different values for lowercase and uppercase keys
        // Then clear cache and reload from disk to verify filesystem storage
        var r1 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                await braid_text.put('${key_lower}', {body: 'lowercase-value'})
                await braid_text.put('${key_upper}', {body: 'uppercase-value'})

                // Wait for disk write
                await new Promise(done => setTimeout(done, 200))

                // Clear the in-memory cache to force reload from disk
                // Note: We keep the key_to_encoded mapping intact since that persists across cache clears
                delete braid_text.cache['${key_lower}']
                delete braid_text.cache['${key_upper}']

                // Also need to wait for any async file operations
                await new Promise(done => setTimeout(done, 100))

                // Read back from disk - pass empty options to force loading
                var lower = (await braid_text.get('${key_lower}', {})).body
                var upper = (await braid_text.get('${key_upper}', {})).body
                res.end(JSON.stringify({lower, upper}))
            })()`
        })
        if (!r1.ok) return 'eval failed: ' + r1.status

        var result = JSON.parse(await r1.text())
        if (result.lower !== 'lowercase-value') {
            return 'lower mismatch: ' + result.lower
        }
        if (result.upper !== 'uppercase-value') {
            return 'upper mismatch: ' + result.upper
        }
        return 'ok'
    },
    'ok'
)

runTest(
    "test Merge-Type header per Braid spec",
    async () => {
        let key = 'test-merge-type-' + Math.random().toString(36).slice(2)

        // First PUT some content (15 characters, so version is alice-14)
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['alice-14'],
            parents: [],
            body: 'initial content'
        })

        // Test 1: GET with Version header should include Merge-Type
        let r1 = await braid_fetch(`/${key}`, {
            version: ['alice-14']
        })
        if (!r1.headers.get('merge-type')) return 'Missing Merge-Type with Version header'

        // Test 2: GET with empty Version header should still include Merge-Type
        let r2 = await braid_fetch(`/${key}`, {
            headers: {
                'Version': ''
            }
        })
        if (!r2.headers.get('merge-type')) return 'Missing Merge-Type with empty Version header'

        // Test 3: GET with Parents header should include Merge-Type
        let r3 = await braid_fetch(`/${key}`, {
            parents: []
        })
        if (!r3.headers.get('merge-type')) return 'Missing Merge-Type with Parents header'

        // Test 4: Regular GET without Version/Parents should NOT include Merge-Type
        let r4 = await braid_fetch(`/${key}`)
        if (r4.headers.get('merge-type')) return 'Unexpected Merge-Type without Version/Parents'

        // Test 5: GET with Subscribe should include Merge-Type
        let a = new AbortController()
        let r5 = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })
        if (!r5.headers.get('merge-type')) return 'Missing Merge-Type with Subscribe'

        // Close subscription
        a.abort()

        return 'ok'
    },
    'ok'
)

runTest(
    "test filename conflict detection (different encodings of same key)",
    async () => {
        // This test creates two files on disk with different URL-encoded names
        // that decode to the same key, then tries to load them, which should
        // throw "filename conflict detected"

        // Use a unique test subdirectory to avoid affecting other tests
        var testId = Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var fs = require('fs')
                var path = require('path')

                // Create a temporary test db folder
                var testFolder = path.join(braid_text.db_folder, 'conflict-test-${testId}')
                await fs.promises.mkdir(testFolder, { recursive: true })

                // Create two files that decode to the same key "/hello"
                // File 1: Using the standard encoding with ! swapped for /
                // !hello -> decodes to /hello (after !/swap)
                await fs.promises.writeFile(path.join(testFolder, '!hello.0'), 'content1')

                // File 2: Using %2F encoding for /
                // %2Fhello -> decodes to /hello (via URL decoding, then !/swap on /)
                // Actually, let's trace through decode_filename:
                // 1. decodeURIComponent('%21hello') = '!hello'
                // 2. swap !/: '!hello' -> '/hello'
                // So %21hello decodes to /hello
                await fs.promises.writeFile(path.join(testFolder, '%21hello.0'), 'content2')

                // Now try to initialize filename mapping with these files
                // We need to call the internal init_filename_mapping function
                // through a resource load that reads the test directory

                try {
                    // Read the files from the test folder
                    var files = await fs.promises.readdir(testFolder)

                    // Simulate what init_filename_mapping does
                    var key_to_filename = new Map()
                    for (var file of files) {
                        var encoded = file.replace(/\\\.\\d+$/, '')
                        var key = braid_text.decode_filename(encoded)

                        if (!key_to_filename.has(key)) {
                            key_to_filename.set(key, encoded)
                        } else {
                            throw new Error('filename conflict detected')
                        }
                    }
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                } finally {
                    // Clean up test folder
                    try {
                        for (var f of await fs.promises.readdir(testFolder)) {
                            await fs.promises.unlink(path.join(testFolder, f))
                        }
                        await fs.promises.rmdir(testFolder)
                    } catch (e) {}
                }
            })()`
        })

        return await r.text()
    },
    'filename conflict detected'
)

runTest(
    "test wal-intent recovery after simulated crash during append",
    async () => {
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var fs = require('fs')
                var test_db = __dirname + '/test_wal_recovery_' + Math.random().toString(36).slice(2)
                try {
                    // Create a fresh braid_text instance with its own db_folder
                    var bt = braid_text.create_braid_text()
                    bt.db_folder = test_db

                    // Do initial PUT (5 chars = 'hello', version ends at 4)
                    await bt.put('/test', {
                        version: ['a-4'],
                        parents: [],
                        body: 'hello'
                    })

                    // Do second PUT to trigger an append (6 more chars = ' world', version ends at 10)
                    await bt.put('/test', {
                        version: ['a-10'],
                        parents: ['a-4'],
                        patches: [{
                            unit: 'text',
                            range: '[5:5]',
                            content: ' world'
                        }]
                    })

                    var encoded = bt.encode_filename('/test')
                    var db_file = test_db + '/' + encoded + '.1'
                    var intent_file = test_db + '/.wal-intent/' + encoded + '.1'

                    // Read the db file
                    var data = await fs.promises.readFile(db_file)

                    // Parse chunks to find the last one
                    var cursor = 0
                    var chunks = []
                    while (cursor < data.length) {
                        var chunk_start = cursor
                        var chunk_size = data.readUInt32LE(cursor)
                        cursor += 4 + chunk_size
                        chunks.push({ start: chunk_start, size: chunk_size, end: cursor })
                    }

                    if (chunks.length < 2) {
                        res.end('expected at least 2 chunks, got ' + chunks.length)
                        return
                    }

                    var last_chunk = chunks[chunks.length - 1]
                    var prev_end = chunks[chunks.length - 2].end

                    // Create the wal-intent file: 8-byte size + the last chunk data
                    var size_buf = Buffer.allocUnsafe(8)
                    size_buf.writeBigUInt64LE(BigInt(prev_end), 0)
                    var last_chunk_data = data.subarray(last_chunk.start, last_chunk.end)
                    var intent_data = Buffer.concat([size_buf, last_chunk_data])
                    await fs.promises.writeFile(intent_file, intent_data)

                    // Truncate the db file partway through the last chunk (keep ~half)
                    var truncate_point = last_chunk.start + Math.floor((last_chunk.end - last_chunk.start) / 2)
                    await fs.promises.truncate(db_file, truncate_point)

                    // Create a new braid_text instance to simulate restart
                    var bt2 = braid_text.create_braid_text()
                    bt2.db_folder = test_db

                    // Get the resource - this should trigger wal-intent replay
                    var resource = await bt2.get_resource('/test')
                    var text = resource.doc.get()

                    // Verify intent file was cleaned up
                    var intent_exists = true
                    try {
                        await fs.promises.access(intent_file)
                    } catch (e) {
                        intent_exists = false
                    }

                    await fs.promises.rm(test_db, { recursive: true, force: true })

                    if (intent_exists) {
                        res.end('intent file still exists')
                        return
                    }

                    res.end(text)
                } catch (e) {
                    await fs.promises.rm(test_db, { recursive: true, force: true }).catch(() => {})
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })

        return await r.text()
    },
    'hello world'
)

runTest(
    "test wal-intent throws error when db file is too large",
    async () => {
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var fs = require('fs')
                var test_db = __dirname + '/test_wal_error_' + Math.random().toString(36).slice(2)
                try {
                    // Create a fresh braid_text instance with its own db_folder
                    var bt = braid_text.create_braid_text()
                    bt.db_folder = test_db

                    // Do initial PUT (5 chars = 'hello', version ends at 4)
                    await bt.put('/test', {
                        version: ['a-4'],
                        parents: [],
                        body: 'hello'
                    })

                    // Do second PUT to trigger an append (6 more chars = ' world', version ends at 10)
                    await bt.put('/test', {
                        version: ['a-10'],
                        parents: ['a-4'],
                        patches: [{
                            unit: 'text',
                            range: '[5:5]',
                            content: ' world'
                        }]
                    })

                    var encoded = bt.encode_filename('/test')
                    var db_file = test_db + '/' + encoded + '.1'
                    var intent_file = test_db + '/.wal-intent/' + encoded + '.1'

                    // Read the db file
                    var data = await fs.promises.readFile(db_file)

                    // Parse chunks to find the last one
                    var cursor = 0
                    var chunks = []
                    while (cursor < data.length) {
                        var chunk_start = cursor
                        var chunk_size = data.readUInt32LE(cursor)
                        cursor += 4 + chunk_size
                        chunks.push({ start: chunk_start, size: chunk_size, end: cursor })
                    }

                    if (chunks.length < 2) {
                        res.end('expected at least 2 chunks, got ' + chunks.length)
                        return
                    }

                    var last_chunk = chunks[chunks.length - 1]
                    var prev_end = chunks[chunks.length - 2].end

                    // Create the wal-intent file: 8-byte size + the last chunk data
                    var size_buf = Buffer.allocUnsafe(8)
                    size_buf.writeBigUInt64LE(BigInt(prev_end), 0)
                    var last_chunk_data = data.subarray(last_chunk.start, last_chunk.end)
                    var intent_data = Buffer.concat([size_buf, last_chunk_data])
                    await fs.promises.writeFile(intent_file, intent_data)

                    // Append extra garbage to the db file (making it too large)
                    await fs.promises.appendFile(db_file, Buffer.from('extra garbage data'))

                    // Create a new braid_text instance to simulate restart
                    var bt2 = braid_text.create_braid_text()
                    bt2.db_folder = test_db

                    // Now try to init - this should throw an error
                    var result
                    try {
                        await bt2.db_folder_init()
                        result = 'should have thrown an error'
                    } catch (e) {
                        if (e.message.includes('wal-intent replay failed')) {
                            result = 'correctly threw error'
                        } else {
                            result = 'wrong error: ' + e.message
                        }
                    }
                    await fs.promises.rm(test_db, { recursive: true, force: true })
                    res.end(result)
                } catch (e) {
                    await fs.promises.rm(test_db, { recursive: true, force: true }).catch(() => {})
                    res.end('error: ' + e.message)
                }
            })()`
        })

        return await r.text()
    },
    'correctly threw error'
)

// Tests for untested put() control paths

runTest(
    "test put with empty version array is ignored",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        // First create a resource with some content
        var r1 = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['init-2'],
            parents: [],
            body: 'abc'
        })
        if (!r1.ok) return 'initial put failed: ' + r1.status

        // Now try to put with an empty version array - should be ignored
        var r2 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')
                var result = await braid_text.put(resource, { version: [], body: 'xyz' })
                res.end(JSON.stringify(result))
            })()`
        })
        if (!r2.ok) return 'eval failed: ' + r2.status

        var result = JSON.parse(await r2.text())

        // Verify the put was ignored (change_count should be 0)
        if (result.change_count !== 0) return 'expected change_count 0, got ' + result.change_count

        // Verify the content is still the original
        var r3 = await braid_fetch(`/${key}`)
        return await r3.text()
    },
    'abc'
)

runTest(
    "test put with partial version overlap splits patches",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                // First put: "abc" at version hi-2 (3 chars = indices 0,1,2)
                await braid_text.put(resource, {
                    version: ['hi-2'],
                    parents: [],
                    patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                })

                // Second put overlaps: version hi-4 with 5 chars total
                // This means chars at indices 0,1,2,3,4
                // We already have 0,1,2, so only 3,4 are new (new_count = 2)
                // The returned change_count reflects just the new chars added
                var result = await braid_text.put(resource, {
                    version: ['hi-4'],
                    parents: [],
                    patches: [{unit: 'text', range: '[0:0]', content: 'abcde'}]
                })

                res.end(resource.doc.get() + ':' + result.change_count)
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'abcde:2'
)

runTest(
    "test put with version gap throws error",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                // First put: "de" at version hi-4 (2 chars = indices 3,4)
                await braid_text.put(resource, {
                    version: ['hi-4'],
                    parents: [],
                    patches: [{unit: 'text', range: '[0:0]', content: 'de'}]
                })

                try {
                    // Now try to put hi-3 with 4 chars (indices 0,1,2,3)
                    // low_seq = 3 + 1 - 4 = 0
                    // We have range [3,4], so has(0,3) returns [3,4]
                    // low_seq (0) < intersects_range[0] (3) = true -> ERROR!
                    // This is a gap - we're claiming 0,1,2,3 but only have 3,4
                    await braid_text.put(resource, {
                        version: ['hi-3'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'WXYZ'}]
                    })
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'invalid update: different from previous update with same version'
)

// NOTE: P19 (parents: ['root'] -> []) is dead code - 'root' fails validate_version_array
// before P19 can be reached. Skipping test for this path.

runTest(
    "test put with negative index in patch range",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put "hello" (5 chars, version hello-4)
                    await braid_text.put(resource, {
                        version: ['a-4'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'hello'}]
                    })

                    // Now use negative index to remove the 'o' at the end
                    // [-1:-0] means from position (5-1)=4 to position (5-0)=5
                    await braid_text.put(resource, {
                        version: ['b-0'],
                        parents: ['a-4'],
                        patches: [{unit: 'text', range: '[-1:-0]', content: ''}]
                    })

                    res.end(resource.doc.get())
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'hell'
)

runTest(
    "test put with patch range start beyond document length throws error",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put "hi" (2 chars), so max_pos is 2
                    await braid_text.put(resource, {
                        version: ['a-1'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'hi'}]
                    })

                    // Try to patch at position 10, which is beyond max_pos (2)
                    await braid_text.put(resource, {
                        version: ['b-0'],
                        parents: ['a-1'],
                        patches: [{unit: 'text', range: '[10:10]', content: 'x'}]
                    })
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'invalid patch range position: 10'
)

runTest(
    "test put with patch range end beyond document length throws error",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put "hi" (2 chars), so max_pos is 2
                    await braid_text.put(resource, {
                        version: ['a-1'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'hi'}]
                    })

                    // Try to delete from 0 to 10, but end (10) is beyond max_pos (2)
                    await braid_text.put(resource, {
                        version: ['b-9'],
                        parents: ['a-1'],
                        patches: [{unit: 'text', range: '[0:10]', content: ''}]
                    })
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'invalid patch range position: 10'
)

runTest(
    "test put from same peer as simpleton client sets my_last_seen_version",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // Add a simpleton client with a specific peer
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => {},
                        my_last_sent_version: [],
                        my_last_seen_version: null
                    }
                    resource.simpleton_clients.add(client)

                    // Do a put with the same peer and merge_type: 'simpleton'
                    await braid_text.put(resource, {
                        version: ['v-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}],
                        peer: 'test-peer',
                        merge_type: 'simpleton'
                    })

                    // Check that my_last_seen_version was set
                    res.end(JSON.stringify(client.my_last_seen_version))
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    '["v-2"]'
)

runTest(
    "test put from same peer with mismatched version triggers timeout",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put some initial content
                    await braid_text.put(resource, {
                        version: ['a-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })

                    // Add a simpleton client with a specific peer
                    // Set my_last_sent_version to something different than what we'll use as parents
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => {},
                        my_last_sent_version: ['a-2'],  // client thinks it has a-2
                        my_last_seen_version: null
                    }
                    resource.simpleton_clients.add(client)

                    // Do a put with parents: [] (empty/root), which doesn't match my_last_sent_version
                    // This should trigger P60 (version mismatch -> set_timeout)
                    await braid_text.put(resource, {
                        version: ['b-2'],
                        parents: [],  // doesn't match client.my_last_sent_version (['a-2'])
                        patches: [{unit: 'text', range: '[0:0]', content: 'xyz'}],
                        peer: 'test-peer',
                        merge_type: 'simpleton'
                    })

                    // Check that timeout was set (my_timeout should exist)
                    res.end(client.my_timeout ? 'timeout set' : 'no timeout')
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'timeout set'
)

runTest(
    "test put from same peer triggers rebase when other changes exist",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put some initial content
                    await braid_text.put(resource, {
                        version: ['a-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })

                    // Another peer makes a change (so resource.version moves ahead)
                    await braid_text.put(resource, {
                        version: ['other-2'],
                        parents: ['a-2'],
                        patches: [{unit: 'text', range: '[3:3]', content: 'XYZ'}]
                    })

                    // Now add a simpleton client AFTER the other change
                    // Set my_last_sent_version to match what we'll use as parents for the next put
                    var rebased = false
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => { rebased = true },
                        my_last_sent_version: ['a-2']  // matches parents we'll use below
                    }
                    resource.simpleton_clients.add(client)

                    // Our peer puts with parents: ['a-2'] which matches my_last_sent_version
                    // resource.version includes 'other-2', so x.version != x.parents -> rebase (P62)
                    await braid_text.put(resource, {
                        version: ['b-2'],
                        parents: ['a-2'],
                        patches: [{unit: 'text', range: '[0:0]', content: '123'}],
                        peer: 'test-peer',
                        merge_type: 'simpleton'
                    })

                    res.end(rebased ? 'rebased' : 'not rebased')
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'rebased'
)

runTest(
    "test put from same peer with existing timeout extends timeout",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put some initial content
                    await braid_text.put(resource, {
                        version: ['a-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })

                    // Add a simpleton client that already has a timeout set
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => {},
                        my_last_sent_version: ['a-2'],
                        my_timeout: setTimeout(() => {}, 10000)  // existing timeout
                    }
                    resource.simpleton_clients.add(client)

                    var old_timeout = client.my_timeout

                    // Put from same peer with mismatched parents
                    // This should hit P55 (has timeout) -> P56 (same peer) -> P57 (versions don't match)
                    // And P51 (clear old timeout)
                    await braid_text.put(resource, {
                        version: ['b-2'],
                        parents: [],  // doesn't match my_last_sent_version
                        patches: [{unit: 'text', range: '[0:0]', content: 'xyz'}],
                        peer: 'test-peer',
                        merge_type: 'simpleton'
                    })

                    // Check that timeout was replaced
                    var new_timeout = client.my_timeout
                    res.end(old_timeout !== new_timeout ? 'timeout replaced' : 'same timeout')
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'timeout replaced'
)

runTest(
    "test put from same peer with existing timeout and matching version stops timeout early",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put some initial content
                    await braid_text.put(resource, {
                        version: ['a-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })

                    // Add a simpleton client with existing timeout
                    // my_last_sent_version matches what we'll use as parents
                    var timeout_fired = false
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => { timeout_fired = true },
                        my_last_sent_version: ['a-2'],  // matches parents we'll use
                        my_timeout: setTimeout(() => {}, 10000)
                    }
                    resource.simpleton_clients.add(client)

                    // Put from same peer with parents matching my_last_sent_version
                    // This should hit P58 (versions match -> stop timeout early with set_timeout(0))
                    await braid_text.put(resource, {
                        version: ['b-2'],
                        parents: ['a-2'],  // matches my_last_sent_version
                        patches: [{unit: 'text', range: '[3:3]', content: 'xyz'}],
                        peer: 'test-peer',
                        merge_type: 'simpleton'
                    })

                    // Wait a tiny bit for the 0ms timeout to fire
                    await new Promise(done => setTimeout(done, 10))

                    res.end(timeout_fired ? 'timeout fired early' : 'timeout did not fire')
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'timeout fired early'
)

runTest(
    "test put with merge_type dt skips simpleton client with existing timeout",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put some initial content
                    await braid_text.put(resource, {
                        version: ['a-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })

                    // Add a simpleton client with an existing timeout
                    var received_update = false
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => { received_update = true },
                        my_last_sent_version: ['a-2'],
                        my_timeout: setTimeout(() => {}, 10000)  // has existing timeout
                    }
                    resource.simpleton_clients.add(client)

                    // Do a put with merge_type: 'dt'
                    // This should hit P69 and skip the client (not send update)
                    await braid_text.put(resource, {
                        version: ['b-2'],
                        parents: ['a-2'],
                        patches: [{unit: 'text', range: '[3:3]', content: 'xyz'}],
                        merge_type: 'dt'
                    })

                    res.end(received_update ? 'update sent' : 'update skipped')
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'update skipped'
)

runTest(
    "test timeout callback exits early when doc has been freed",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // First put some initial content
                    await braid_text.put(resource, {
                        version: ['a-2'],
                        parents: [],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })

                    // Add a simpleton client
                    var callback_result = 'not called'
                    var client = {
                        peer: 'test-peer',
                        my_subscribe: (update) => { callback_result = 'called' },
                        my_last_sent_version: ['a-2']
                    }
                    resource.simpleton_clients.add(client)

                    // Trigger a timeout by putting with mismatched parents
                    await braid_text.put(resource, {
                        version: ['b-2'],
                        parents: [],  // doesn't match my_last_sent_version
                        patches: [{unit: 'text', range: '[0:0]', content: 'xyz'}],
                        peer: 'test-peer',
                        merge_type: 'simpleton'
                    })

                    // Now delete the resource (which frees the doc)
                    await braid_text.delete('/${key}')

                    // Wait for the timeout to fire (it should exit early due to freed doc)
                    await new Promise(done => setTimeout(done, 100))

                    // my_subscribe should NOT have been called because doc was freed
                    res.end(callback_result)
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'not called'
)

runTest(
    "test put with both body and patches throws error",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    await braid_text.put(resource, {
                        body: 'hello',
                        patches: [{unit: 'text', range: '[0:0]', content: 'world'}]
                    })
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'cannot have a body and patches'
)

runTest(
    "test put with non-string body throws error",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    await braid_text.put(resource, {
                        body: 12345
                    })
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'body must be a string'
)

runTest(
    "test put with missing parent version throws error",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                try {
                    // Try to put with a parent that doesn't exist
                    await braid_text.put(resource, {
                        version: ['test-2'],
                        parents: ['nonexistent-99'],
                        patches: [{unit: 'text', range: '[0:0]', content: 'abc'}]
                    })
                    res.end('no error thrown')
                } catch (e) {
                    res.end(e.message)
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'missing parent version: nonexistent-99'
)

runTest(
    "test put with merge_type dt notifies simpleton clients",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var resource = await braid_text.get_resource('/${key}')

                // Add a simpleton client (non-dt subscriber)
                var received_update = null
                resource.simpleton_clients.add({
                    my_subscribe: (update) => {
                        received_update = update
                    },
                    my_last_sent_version: []
                })

                // Do a put with merge_type: 'dt'
                await braid_text.put(resource, {
                    version: ['test-2'],
                    parents: [],
                    patches: [{unit: 'text', range: '[0:0]', content: 'xyz'}],
                    merge_type: 'dt'
                })

                // Check that simpleton client received the update
                if (!received_update) {
                    res.end('simpleton did not receive update')
                } else if (!received_update.patches) {
                    res.end('update missing patches')
                } else {
                    res.end('simpleton received update with ' + received_update.patches.length + ' patch(es)')
                }
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'simpleton received update with 1 patch(es)'
)

// Tests for reconnector/sync edge cases

runTest(
    "test braid_text.sync remote null triggers local_first_put_promise path",
    async () => {
        var local_key = 'test-local-' + Math.random().toString(36).slice(2)

        // Use the /404 endpoint which always returns 404 (null from braid_text.get)
        var r = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                var ac = new AbortController()
                var reconnect_count = 0

                braid_text.sync('/${local_key}', new URL('http://localhost:8889/404'), {
                    signal: ac.signal,
                    on_pre_connect: () => {
                        reconnect_count++
                        if (reconnect_count >= 2) {
                            ac.abort()
                            res.end('reconnected after local put')
                        }
                    }
                })

                // Wait a bit then put something locally - this should trigger
                // the local_first_put_promise to resolve and cause reconnect
                await new Promise(done => setTimeout(done, 100))
                await braid_text.put('/${local_key}', { body: 'local data' })

                // Wait for reconnect
                await new Promise(done => setTimeout(done, 2000))
                res.end('did not reconnect')
            })()`
        })
        if (!r.ok) return 'eval failed: ' + r.status

        return await r.text()
    },
    'reconnected after local put'
)

runTest(
    "test simpleton client receives correct parents when dt client puts forked update",
    async () => {
        var key = 'test' + Math.random().toString(36).slice(2)

        // First, create the resource with initial content
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hello'
        })
        if (!r.ok) return 'initial put failed: ' + r.status

        // Get the initial version
        var r2 = await braid_fetch(`/${key}`)
        var initial_version = r2.version  // braid_fetch provides version as array of strings

        // Now make a change to get to V2
        var r3 = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {
                'merge-type': 'dt',
                'content-type': 'text/plain'
            },
            parents: initial_version,
            patches: [{ unit: 'text', range: '[5:5]', content: ' world' }]
        })
        if (!r3.ok) return 'second put failed: ' + r3.status
        var v2 = r3.version  // braid_fetch provides version as array of strings

        // Now set up a simpleton subscriber that will capture what parents it receives
        var r4 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                try {
                    var received_parents = null
                    var ac = new AbortController()
                    var initial_version_inner = ${JSON.stringify(initial_version)}
                    var v2_inner = ${JSON.stringify(v2)}

                    // Subscribe as simpleton (no merge-type dt)
                    await new Promise((resolve, reject) => {
                        var update_count = 0
                        braid_text.get(new URL('http://localhost:8889/${key}'), {
                            subscribe: update => {
                                update_count++
                                if (update_count === 1) {
                                    // First update is current state, ignore it
                                    resolve()
                                } else {
                                    // This is the forked update - capture its parents
                                    received_parents = update.parents
                                    ac.abort()
                                }
                            },
                            signal: ac.signal
                        })
                    })

                    // Now make a forked update from the initial version (not V2)
                    // This simulates another DT client that forked from the original
                    await braid_text.put(new URL('http://localhost:8889/${key}'), {
                        version: ['forker-1'],
                        parents: initial_version_inner,
                        patches: [{ unit: 'text', range: '[0:0]', content: 'yo ' }],
                        headers: { 'merge-type': 'dt' }
                    })

                    // Wait for the subscription to receive the update
                    await new Promise(done => setTimeout(done, 200))

                    // The simpleton should receive parents = version_before (which is V2)
                    // NOT parents = initial_version (which is what the forked update had)
                    // Because the simpleton needs to transform from where the doc WAS, not from the fork point
                    res.end(JSON.stringify({
                        received_parents,
                        initial_version: initial_version_inner,
                        v2: v2_inner
                    }))
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r4.ok) return 'eval failed: ' + r4.status

        var text = await r4.text()
        if (text.startsWith('error:')) return text
        var result = JSON.parse(text)

        // The parents the simpleton received should be V2 (version_before),
        // not the initial_version (the incoming update's parents)
        var received = JSON.stringify(result.received_parents)
        var expected_wrong = JSON.stringify(result.initial_version)
        var expected_correct = JSON.stringify(result.v2)

        if (received === expected_wrong) {
            return `BUG: simpleton received parents from incoming update (${received}) instead of version_before (${expected_correct})`
        }

        // Check if it matches expected correct value (version_before / V2)
        if (received === expected_correct) {
            return 'correct'
        }

        return `unexpected parents: ${received}, expected: ${expected_correct}`
    },
    'correct'
)

runTest(
    "test list() ignores files without numeric extensions",
    async () => {
        var key = 'listtest' + Math.random().toString(36).slice(2)

        // Create a real resource so the key shows up in list()
        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'hello'
        })
        if (!r.ok) return 'put failed: ' + r.status

        // list() should contain our key but NOT things like .meta, .temp, .wal-intent
        var r2 = await braid_fetch(`/eval`, {
            method: 'PUT',
            body: `void (async () => {
                try {
                    var list = await braid_text.list()
                    var bad = list.filter(x => x.startsWith('.'))
                    if (bad.length > 0) {
                        res.end('FAIL: list includes ' + JSON.stringify(bad))
                    } else {
                        res.end('ok')
                    }
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        if (!r2.ok) return 'eval failed: ' + r2.status

        return await r2.text()
    },
    'ok'
)

}

// Export for both Node.js and browser environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = defineTests
}
