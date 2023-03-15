import WebSocket from "ws";
import axios from "axios";
import chalk from "chalk";
import fs from "fs";

const streamer = "papan030";

async function getPlaybackAccessToken(streamer_id: string): Promise<{ signature: string; token: string; }> {
    const { data: { data: { streamPlaybackAccessToken: { value: token, signature } } } } = await axios({
        url: `https://gql.twitch.tv/gql`,
        method: "POST",
        headers: {
            "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            "Content-Type": "text/plain;charset=UTF-8",
        },
        data: JSON.stringify({
            operationName: "PlaybackAccessToken",
            variables: {
                isLive: true,
                login: streamer_id,
                isVod: false,
                vodID: "",
                playerType: "frontpage"
            },
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712"
                }
            }
        })        
    });
    return { signature, token };
}

async function get(url: string): Promise<string[]> {
    const { data } = await axios(url);
    return data.split("\n");
}

function getM3U8Url(streamer_id: string, token: string, signature: string): string {
    return `https://usher.ttvnw.net/api/channel/hls/${streamer_id}.m3u8?player=twitchweb&token=${token}&sig=${signature}&allow_source=true&allow_audio_only=true&allow_spectre=true&type=any&p=0`;
}

function filterURL(urls: string[]): string[] {
    return urls.filter((url: string) => url.startsWith("https://"));
}

function numberURLs(m3u8: string) {
    let sequence = parseInt(m3u8.split('\n').find((line: string) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"))?.split(":")[1]!);
    let urls = filterURL(m3u8.split('\n'));
    return urls.map((url: string) => { return { url, sequence: sequence++ } });
}

function decodeM3U8(m3u8: string): string[] {
    return m3u8.split("\n").filter((line: string) => line.startsWith("https://"));
}

if (!fs.existsSync("./sequences")) fs.mkdirSync("./sequences");

let channelId = "";
let sessionId = "";
let signature = "", token = "";
let online = false;

const ws = new WebSocket("wss://pubsub-edge.twitch.tv");

ws.on("open", () => {
    console.log('socket opened, initiating listener ...');

    setInterval(() => {
        ws.send(JSON.stringify({
            type: "PING"
        }));    
    }, 1000 * 60 *3);

    getPlaybackAccessToken(streamer).then(async ({ signature: _signature, token: _token }) => {
        signature = _signature;
        token = _token;
        channelId = JSON.parse(token).channel_id;
        console.log(`signature: ${signature}`);
        console.log(`token: ${token}`);
        console.log(`channel id: ${channelId}`);
        
        ws.send(JSON.stringify({
            type: "LISTEN",
            nonce: "IkgLiKVbRnraWWdbA4I2nodIiAsrHo",
            data: {
                topics: [
                    `video-playback-by-id.${channelId}`
                ]
            }
        }));
        
        console.log('checking if stream is online...');
        await get(getM3U8Url(streamer, token, signature)).then(async (lines) => {
            const videodata = await get(filterURL(lines)[0]);
            sessionId = videodata.find((line: string) => line.match(/X-TV-TWITCH-SESSIONID="(\d+)"/))!.match(/X-TV-TWITCH-SESSIONID="(\d+)"/)![1]!;
            console.log(`session Id: ${sessionId}`);
            fs.mkdirSync(`./sequences/${sessionId}`, { recursive: true });
            m3u8 = filterURL(lines)[0];
            online = true;
            console.log("stream is online");
        }).catch(() => {
            online = false;
            console.log("stream is offline");
        });
    })
    .catch((e) => {
        console.log(e);
        console.log("error getting playback access token");
        return;
    });
});

let m3u8 = "";

setInterval(async () => {
    if (online) {
        const data = await get(m3u8).catch(() => null);
        if (!data) {
            console.log("stream is offline");
            return;
        }
        const urls = numberURLs(data.join("\n"));
        for (let url of urls) {
            if (fs.existsSync(`./sequences/${sessionId}/${url.sequence}.ts`)) continue;
            process.stdout.write(`[${chalk.green(url.sequence)}] downloading ${chalk.gray(url.url).substring(0, process.stdout.columns - 18)}${chalk.white('...')}`);
            const { data } = await axios(url.url, { responseType: "arraybuffer" });
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`[${chalk.green(url.sequence)}] downloaded\n`);
            fs.createWriteStream(`./sequences/${sessionId}/${url.sequence}.ts`).write(data);
        }
    }
}, 2000);

ws.on("message", async buffer => {
    console.log(buffer.toString());
    const { type, data } = JSON.parse(buffer.toString());
    if (type === "MESSAGE") {
        if (data) {
            const { type: data_type } = JSON.parse(data.message);
            if (data_type === "stream-down") {
                console.log("stream went offline");
                online = false;
            } else if (data_type === "stream-up") {
                console.log("stream went online");
                const { signature: _signature, token: _token } = await getPlaybackAccessToken(streamer);
                signature = _signature;
                token = _token;
                console.log(`signature: ${signature}, token: ${token}`);
                m3u8 = filterURL(await get(getM3U8Url(streamer, token, signature)))[0];
                console.log('m3u8: ' + m3u8);
                sessionId = (await get(m3u8)).find((line: string) => line.match(/X-TV-TWITCH-SESSIONID="(\d+)"/g))!.match(/X-TV-TWITCH-SESSIONID="(\d+)"/g)![1]!;
                fs.mkdirSync(`./sequences/${sessionId}`, { recursive: true });
                console.log(`session Id: ${sessionId}`);
                online = true;
            }
        }
    }
});
