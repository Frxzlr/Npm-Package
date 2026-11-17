# Demo scenarios

Small, real crashes used for the README and the launch GIF. Run any of them with and without
whycrash to see the difference:

```sh
node demo/esm-import/index.js                      # raw Node.js error
npx whycrash -- node demo/esm-import/index.js      # + diagnosis

node demo/api-shape/index.cjs
node --import whycrash/register demo/api-shape/index.cjs

node demo/server-down/client.mjs                   # make sure nothing runs on :3000
npx whycrash -- node demo/server-down/client.mjs
```

`demo.tape` records the GIF with [VHS](https://github.com/charmbracelet/vhs):

```sh
vhs demo/demo.tape
```
