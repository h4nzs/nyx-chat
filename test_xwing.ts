import { getSodiumLib } from './web/src/utils/crypto.js';

async function main() {
    const sodium = await getSodiumLib();
    const kp = sodium.crypto_kem_xwing_keypair();
    console.log("PK length:", kp.publicKey.length);
    console.log("SK length:", kp.privateKey.length);
    // Let's see if PK is inside SK
    const pkHex = sodium.to_hex(kp.publicKey);
    const skHex = sodium.to_hex(kp.privateKey);
    console.log("PK in SK?", skHex.includes(pkHex));
    // Usually in Kyber, the SK contains: secret polynomial + public key + H(public key) + random 'z'.
    // If it's at a fixed offset, we can just slice it!
    const pkIndex = skHex.indexOf(pkHex);
    if (pkIndex !== -1) {
        console.log("PK starts at byte offset:", pkIndex / 2);
    }
}
main();
