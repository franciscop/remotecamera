import fsp from "node:fs/promises";
import camera from "remotecamera";

const img = await camera.photo();
await fsp.writeFile(img.name, new Uint8Array(await img.arrayBuffer()));
console.log(`Saved ${img.name}`);

await fsp.writeFile("clip.mp4", camera.video({ duration: 5 }));
console.log("Saved clip.mp4");

// Or upload the photo to your own server:
// const form = new FormData();
// form.append("image", img);
// await fetch("https://example.com/upload", { method: "POST", body: form });
