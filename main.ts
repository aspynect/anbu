import * as fs from "node:fs";
import { Client, CredentialManager, ok} from '@atcute/client';
import { AppBskyFeedPost } from '@atcute/bluesky'
import {} from '@atcute/atproto'
import { ResourceUri } from '@atcute/lexicons/syntax'
import * as TID from '@atcute/tid'
import { ActorIdentifier } from "@atcute/lexicons";
import secrets from "./secrets.json" with { type: "json" };
import usersJson from "./users.json" with { type: "json" }
import { spawn } from "node:child_process";

type UserData = {
    timestamp: string;
    config: {
        baseInterval: number;
        stdev: number;
    }
}
const users = new Map<string, UserData>(Object.entries(usersJson));

const manager = new CredentialManager({ service: 'https://bsky.social' });
const rpc = new Client({ handler: manager });
await manager.login({ identifier: secrets.username, password: secrets.password });
console.log(manager.session);
const didData = await ok(
		rpc.get('com.atproto.identity.resolveHandle', {
			params: {
				handle: secrets.username as `${string}.${string}`,
			},
		}),
	);
const did = didData.did
// TODO set up reinitializing w/ saved cursor if available? but like lowkey not necessary and dont super gaf
const jetURL = new URL("wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post")
jetURL.searchParams.append("wantedDids", did)
const jetSocket = new WebSocket(jetURL);

const spaceURL = new URL("https://spacedust.microcosm.blue/subscribe")
spaceURL.searchParams.append("wantedSubjectDids", did)
spaceURL.searchParams.append("wantedSources", "app.bsky.graph.follow:subject")
// spaceURL. searchParams.append("instant", "true")
const spaceSocket = new WebSocket(spaceURL)


function updateUsers() {
    jetSocket.send(JSON.stringify({
        "type": "options_update",
        "payload": {
            "wantedCollections": ["app.bsky.feed.post"],
            "wantedDids": [...users.keys()],
            "maxMessageSizeBytes": 1000000
        }
    }))
    console.log(users)
    fs.writeFile('users.json', JSON.stringify(Object.fromEntries(users), null, 4), (err) => {
        if (err) {
            console.log('Error writing file:', err);
        } else {
            console.log('Successfully wrote file');
        }
    });
};


async function train(trainString: string) {
    return await new Promise((resolve, reject) => {
        const process = spawn("python3", ["markov.py", "-train", trainString]);

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

function gen(inputString: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = spawn("python3", ["markov.py", "-gen", inputString]);

        let stdout = "";
        let stderr = "";

        process.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        process.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        process.on("close", (code) => {
        if (code !== 0) {
            reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        } else {
            const output = stdout.trim();
            if (output === "None") {
                resolve("");
            } else {
                resolve(output);
            }
        }
        });
    });
}


function checkEligibility(userData: UserData): boolean {
    return new Date().toISOString() > userData.timestamp
}

function updateTimestamp(userData: UserData) {
    userData.timestamp = randomFutureDate(userData.config.baseInterval, userData.config.stdev) 
}

function randomFutureDate(mean: number, stdDev: number): string {
    let u = 0, v = 0;
    // Convert [0,1) to (0,1) to avoid log(0)
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    // Box–Muller transform for standard normal (mean = 0, std = 1)
    const standardNormal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const value = (new Date().getTime()) + mean + standardNormal * stdDev;
    return new Date(Math.round(value)).toISOString();
}

async function followCheck(did: string): Promise<boolean> {
    const data = await ok(
        rpc.get("app.bsky.actor.getProfile", {
            params: {
                actor: did as ActorIdentifier
            }
        })
    )
    return (!!data.viewer?.followedBy && !data.viewer?.blockedBy)
}

async function replyToPost(contents: string, post: AppBskyFeedPost.Main, cid: string, uri: string) {
    let output = ""
    let tryCount = 0
    while (tryCount < 20) {
        output = await gen(contents)
        console.log(output)
        if (!!output) break
        tryCount++
    }
    if (!output) {
        console.log(`Failed to generate text for ${output}`)
        return
    }
    const data = await ok(
        rpc.post('com.atproto.repo.putRecord', {
            input: {
                collection: "app.bsky.feed.post",
                repo: did,
                rkey: TID.now(),
                record: {
                    $type: "app.bsky.feed.post",
                    text: output,
                    createdAt: new Date().toISOString(),
                    reply: {
                        parent: {
                            cid,
                            uri: uri as ResourceUri
                        },
                        root: post?.reply ? post.reply.root : {cid, uri: uri as ResourceUri}
                    },
                } satisfies AppBskyFeedPost.Main
            }
        }),
    );
    console.log(data)
}

setInterval(async () => {
    const data = await ok(
        rpc.get("chat.bsky.convo.listConvos", {
            params: {
                readState:"unread",
                limit:100,
            },
            headers: {
                "atproto-proxy": "did:web:api.bsky.chat#bsky_chat"
            }
        })
    )
    if (data.convos.length == 0) {
        return
    }
    for (const convo of data.convos) {
        const userData = users.get(convo.members[1].did)!
        if (!userData) continue
        const messageData = await ok(
            rpc.get("chat.bsky.convo.getMessages", {
                params: {
                    convoId:convo.id,
                    limit:convo.unreadCount,
                },
                headers: {
                    "atproto-proxy": "did:web:api.bsky.chat#bsky_chat"
                }
            })
        )
        let newInterval: string = ""
        let newSTDev: string = ""
        for (const message of messageData.messages.reverse()) {
            if(message.$type !== 'chat.bsky.convo.defs#messageView') continue
            const command = message.text.split(" ")
            if (command.length !== 2 || !Number(command[1])) continue
            switch (command[0]) {
                case "interval":
                    newInterval = `${command[0]}=${command[1]}`
                    userData.config.baseInterval =  Number(command[1]) * 60 * 1000
                    break;
                case "stdev":
                    newSTDev = `${command[0]}=${command[1]}`
                    userData.config.stdev =  Number(command[1]) * 60 * 1000
                    break;
            }
        }
        await ok(
            rpc.post("chat.bsky.convo.sendMessage", {
                input: {
                    convoId:convo.id,
                    message: {
                        text: (!!newInterval || !!newSTDev)? `Processed commands: ${[newInterval, newSTDev].filter(Boolean).join(", ")}`: "No successful commands ran"
                    }
                },
                headers: {
                    "atproto-proxy": "did:web:api.bsky.chat#bsky_chat"
                }
            })
        )
    }
    await ok(
        rpc.post("chat.bsky.convo.updateAllRead", {
            input: {},
            headers: {
                "atproto-proxy": "did:web:api.bsky.chat#bsky_chat"
            }
        })
    )
    console.log("DMs processed")
    updateUsers()
}, 30 * 1000)

jetSocket.onopen = () => {
    updateUsers()
}

jetSocket.addEventListener("message", async event => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data)
    if (msg.kind !== "commit" || msg.commit?.operation !== "create") return;
    console.log(msg)

    const postContents = `"${msg.commit.record.text}`
    if (postContents.length < 12) return;

    const interactionDid = msg.did
    const userData = users.get(interactionDid)
    if (!userData) return

    if (!await followCheck(interactionDid)) {
        users.delete(interactionDid)
        updateUsers()
        console.log(`Removed user ${interactionDid}`)
        return
    }
    {
        let trainingString = ""
        if (msg.reply?.parent.$type === "app.bsky.feed.defs#postView") {
            const parentText = msg.reply.parent.record.text
            if (typeof parentText === "string" && parentText.length >= 10) {
                console.log("parent: " + parentText)
                trainingString += msg.reply.parent.record.text + "\n"
            }
        }
        trainingString += postContents
        await train(trainingString)
    }
    if (checkEligibility(userData)) {
        replyToPost(postContents, msg.commit.record, msg.commit.cid, `at://${interactionDid}/${msg.commit.collection}/${msg.commit.rkey}`)
    } else {
        console.log(`Ineligible for ${(new Date(userData.timestamp).getTime() - Date.now())/60000}`)
        return
    }
    updateTimestamp(userData)
    updateUsers()
})

spaceSocket.addEventListener("message", event => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data)
    console.log(msg)
    const followerDid: string = msg.link.source_record.split("/")[2]
    // TODO change the default later (actually not maybe tbh i think its fun to get a reply early)
    users.set(followerDid, {timestamp: new Date().toISOString()/*randomFutureDate(3600000, 900000)*/, config: {baseInterval: 3600000, stdev: 900000}
    })
    updateUsers()
})