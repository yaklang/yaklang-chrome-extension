console.log("Loaded content.js")

window.addEventListener("message", (event) => {
    if (event.data.type && (event.data.type === "TEST")) {
        console.log(event)
        const name = event.data.fn_name
        const args = event.data.args
        const a = (fn, args) => {
            return window[fn](args)
        }
        const zz = a(name, args)
        window.postMessage({type: "FROM_PAGE", text: zz}, "*")
    }
}, );