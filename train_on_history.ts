import { Client, CredentialManager, ok} from '@atcute/client';
import secrets from "./secrets.json" with { type: "json" };
import { spawn } from "node:child_process";
import { ActorIdentifier } from "@atcute/lexicons";

const manager = new CredentialManager({ service: 'https://bsky.social' });
const rpc = new Client({ handler: manager });
await manager.login({ identifier: secrets.username, password: secrets.password });
console.log(manager.session);

const dids: string[] = []
let cur = ""

async function train(trainString: string) {
    return await new Promise((resolve, reject) => {
        const process = spawn("./env/bin/python", ["markov.py", "-train", trainString]);

        let stderr = "";

        process.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        process.on("close", (code) => {
        if (code !== 0) {
            reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        } else {
            resolve("");
        }
        });
    });
}

for (const did of dids) {
    while (true) {
        const data = await ok(
            rpc.get("app.bsky.feed.getAuthorFeed", {
                params: {
                    actor: did as ActorIdentifier,
                    limit: 100,
                    cursor: cur
                }
            })
        )
        if (data.feed.length === 0) break
        if (data.cursor) cur = data.cursor; else break
        for (const post of data.feed) {
            const postText = post.post.record.text;
            if (typeof postText !== "string" || postText.length < 10) continue
            console.log(postText)
            let trainingString = ""
            if (post.reply?.parent.$type === "app.bsky.feed.defs#postView") {
                const parentText = post.reply.parent.record.text
                if (typeof parentText === "string" && parentText.length >= 10) {
                    console.log("parent: " + parentText)
                    trainingString += post.reply.parent.record.text + "\n"
                }
            }
            trainingString += post.post.record.text + "\n"
            await train(trainingString)
        }
    }
}
