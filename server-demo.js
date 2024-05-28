
var port = process.argv[2] || 8888

var braid_text = require("./index.js")

// TODO: set a custom database folder
// (the default is ./braid-text-db)
//
// braid_text.db_folder = './custom_db_folder'

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    // Free the CORS
    free_the_cors(req, res)
    if (req.method === 'OPTIONS') return


    if (req.url.endsWith("?editor")) {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        require("fs").createReadStream("./editor.html").pipe(res)
        return
    }

    if (req.url.endsWith("?markdown-editor")) {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" })
        require("fs").createReadStream("./markdown-editor.html").pipe(res)
        return
    }

    // TODO: uncomment out the code below to add /pages endpoint,
    // which displays all the currently used keys
    // 
    // if (req.url === '/pages') {
    //     var pages = await braid_text.list()
    //     res.writeHead(200, {
    //         "Content-Type": "application/json",
    //         "Access-Control-Expose-Headers": "*"
    //     })
    //     res.end(JSON.stringify(pages))
    //     return
    // }

    // TODO: uncomment and change admin_pass above,
    // and uncomment out the code below to add basic access control
    // 
    // var admin_pass = "fake_password"
    //
    // if (req.url === '/login_' + admin_pass) {
    //     res.writeHead(200, {
    //         "Content-Type": "text/plain",
    //         "Set-Cookie": `admin_pass=${admin_pass}; Path=/`,
    //     });
    //     res.end("Logged in successfully");
    //     return;
    // }
    //
    // if (req.method == "PUT" || req.method == "POST" || req.method == "PATCH") {
    //     if (!req.headers.cookie?.includes(`admin_pass=${admin_pass}`)) {
    //         console.log("Blocked PUT:", { cookie: req.headers.cookie })
    //         res.statusCode = 401
    //         return res.end()
    //     }
    // }

    // Create some initial text for new documents
    if (await braid_text.get(req.url) === undefined) {
        await braid_text.put(req.url, {body: 'This is a fresh blank document, ready for you to edit.' })
    }

    // Now serve the collaborative text!
    braid_text.serve(req, res)
})

server.listen(port, () => {
    console.log(`server started on port ${port}`)
})


// Free the CORS!
function free_the_cors (req, res) {
    res.setHeader('Range-Request-Allow-Methods', 'PATCH, PUT')
    res.setHeader('Range-Request-Allow-Units', 'json')
    res.setHeader("Patches", "OK")
    var free_the_cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, HEAD, GET, PUT, UNSUBSCRIBE",
        "Access-Control-Allow-Headers": "subscribe, client, version, parents, merge-type, content-type, patches, cache-control, peer"
    }
    Object.entries(free_the_cors).forEach(x => res.setHeader(x[0], x[1]))
    if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
    }
}
