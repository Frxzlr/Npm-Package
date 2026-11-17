# Records demo/whycrash.gif — run from the repository root: vhs demo/demo.tape
Output demo/whycrash.gif

Set Shell "bash"
Set FontSize 15
Set Width 1180
Set Height 760
Set Padding 24
Set TypingSpeed 35ms

Hide
Type "npm run build --silent && clear"
Enter
Sleep 2s
Show

Type "node demo/api-shape/index.cjs"
Enter
Sleep 2.5s
Type "clear"
Enter
Type "node dist/cli.js -- node demo/api-shape/index.cjs"
Enter
Sleep 5s

Type "clear"
Enter
Type "node dist/cli.js -- node demo/esm-import/index.js"
Enter
Sleep 5s

Type "clear"
Enter
Type "node dist/cli.js -- node demo/server-down/client.mjs"
Enter
Sleep 5s
