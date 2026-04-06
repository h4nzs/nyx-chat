const sodium = require('libsodium-wrappers');
(async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const pk = sodium.crypto_scalarmult_base(kp.privateKey);
    console.log(sodium.to_base64(kp.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING));
    console.log(sodium.to_base64(pk, sodium.base64_variants.URLSAFE_NO_PADDING));
})();
