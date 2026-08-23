//! End-to-end identity flow against a real server: scratch → pending device →
//! QR pairing → first-phone bootstrap → desktop finalize → rotating session →
//! CSRF logout → silent device recovery. Replays fail closed.

mod common;

use common::{DeviceKey, TestServer, b64, b64d, cookie_value, now_ms, temp_db};
use serde_json::{Value, json};

async fn json_of(response: reqwest::Response) -> Value {
    response.json::<Value>().await.expect("json body")
}

#[tokio::test(flavor = "multi_thread")]
async fn scratch_to_principal_lifecycle() {
    let server = TestServer::spawn(temp_db("auth-flow")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    // 1. First paint: an unauthenticated tab mints a scratch capability.
    let scratch = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await
    .clone();
    let scratch_id = scratch["scratchId"].as_str().unwrap().to_owned();
    let capability = scratch["capability"].as_str().unwrap().to_owned();
    let scratch_auth = format!("MarksScratch {scratch_id}.{capability}");

    // A bad capability is one indistinguishable failure.
    let bad = http
        .get(format!("{base}/v1/documents"))
        .header(
            "Authorization",
            format!("MarksScratch {scratch_id}.{}", b64(&[9_u8; 32])),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 401);

    // 2. Bind the browser's pending P-256 device key.
    let browser_key = DeviceKey::generate();
    let browser_device_id = "device_browser_test1".to_owned();
    let bound = http
        .put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
        .header("Authorization", &scratch_auth)
        .json(
            &json!({ "deviceId": browser_device_id, "publicKey": b64(&browser_key.public_sec1()) }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(bound.status(), 204);

    // 3. Scratch documents work without any principal.
    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Authorization", &scratch_auth)
            .json(&json!({ "title": "scratch notes" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();

    // 4. Create the two-minute QR pairing.
    let pairing = json_of(
        http.post(format!("{base}/v1/auth/pairings"))
            .header("Authorization", &scratch_auth)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let pairing_id = pairing["pairingId"].as_str().unwrap().to_owned();
    let pairing_secret = pairing["secret"].as_str().unwrap().to_owned();

    // The phone inspects the pairing with the fragment secret.
    let inspect = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/inspect"))
        .json(&json!({ "secret": pairing_secret }))
        .send()
        .await
        .unwrap();
    assert_eq!(inspect.status(), 200);

    // 5. First phone: sign a controller bootstrap with the Rust canonical bytes.
    let controller_key = DeviceKey::generate();
    let now = now_ms();
    let bootstrap = marks_auth::ControllerBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_test1").unwrap(),
        controller_device_id: marks_auth::DeviceId::new("device_phone_test1").unwrap(),
        controller_public_key_hash: controller_key.public_key_hash(),
        pairing_id: marks_auth::PairingId::new(pairing_id.clone()).unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        pending_device_id: marks_auth::DeviceId::new(browser_device_id.clone()).unwrap(),
        pending_device_public_key_hash: browser_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let signature = controller_key.sign_p1363(&bootstrap.signing_bytes());
    let bootstrap_body = json!({
        "secret": pairing_secret,
        "bootstrap": {
            "version": 1,
            "controllerId": "controller_test1",
            "controllerDeviceId": "device_phone_test1",
            "controllerPublicKeyHash": b64(&bootstrap.controller_public_key_hash),
            "pairingId": pairing_id,
            "scratchId": scratch_id,
            "pendingDeviceId": browser_device_id,
            "pendingDevicePublicKeyHash": b64(&bootstrap.pending_device_public_key_hash),
            "issuedAtMs": now,
            "expiresAtMs": now + 60_000,
        },
        "controllerPublicKey": b64(&controller_key.public_sec1()),
        "signature": b64(&signature),
    });
    let approved = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/bootstrap"))
        .json(&bootstrap_body)
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), 201);
    let phone_cookie = cookie_value(
        approved
            .headers()
            .get("set-cookie")
            .expect("phone session cookie")
            .to_str()
            .unwrap(),
    );
    let approved = json_of(approved).await;
    let principal_id = approved["principalId"].as_str().unwrap().to_owned();
    assert!(principal_id.starts_with("principal_"));

    // A replayed bootstrap (consumed pairing) fails closed.
    let replay = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/bootstrap"))
        .json(&bootstrap_body)
        .send()
        .await
        .unwrap();
    assert!(replay.status() == 401 || replay.status() == 409);

    // 6. The desktop tab finalizes with its claimed scratch capability.
    let finalized = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/finalize"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(finalized.status(), 201);
    let desktop_cookie = cookie_value(
        finalized
            .headers()
            .get("set-cookie")
            .expect("desktop session cookie")
            .to_str()
            .unwrap(),
    );
    let finalized = json_of(finalized).await;
    assert_eq!(finalized["principalId"], principal_id.as_str());
    assert_eq!(finalized["deviceId"], browser_device_id.as_str());

    // The scratch capability no longer holds pre-claim authority.
    let stale = http
        .get(format!("{base}/v1/documents"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 401);

    // 7. The claimed document now belongs to the principal.
    let list = json_of(
        http.get(format!("{base}/v1/documents"))
            .header("Cookie", &desktop_cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let ids: Vec<&str> = list["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|document| document["id"].as_str().unwrap())
        .collect();
    assert!(
        ids.contains(&document_id.as_str()),
        "claimed document follows the principal"
    );

    // The phone session sees the same durable file list.
    let phone_list = json_of(
        http.get(format!("{base}/v1/documents"))
            .header("Cookie", &phone_cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(
        phone_list["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|document| document["id"] == document_id.as_str()),
    );

    // 8. Session bootstrap returns the CSRF token; logout requires it.
    let session = json_of(
        http.get(format!("{base}/v1/auth/session"))
            .header("Cookie", &desktop_cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let csrf = session["csrf"].as_str().unwrap().to_owned();

    let missing_csrf = http
        .delete(format!("{base}/v1/auth/session"))
        .header("Cookie", &desktop_cookie)
        .header("Origin", &base)
        .send()
        .await
        .unwrap();
    assert_eq!(missing_csrf.status(), 403);

    let logout = http
        .delete(format!("{base}/v1/auth/session"))
        .header("Cookie", &desktop_cookie)
        .header("Origin", &base)
        .header("X-Marks-CSRF", &csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), 200);
    let after_logout = http
        .get(format!("{base}/v1/auth/session"))
        .header("Cookie", &desktop_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(after_logout.status(), 401);

    // 9. Silent recovery: the enrolled browser key signs a one-use challenge.
    let challenge = json_of(
        http.post(format!("{base}/v1/auth/device/challenges"))
            .json(&json!({ "deviceId": browser_device_id }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let challenge_bytes: [u8; 32] = b64d(challenge["challenge"].as_str().unwrap())
        .try_into()
        .unwrap();
    let proof = marks_auth::DeviceSessionProof {
        version: 1,
        challenge_id: marks_auth::ChallengeId::new(
            challenge["challengeId"].as_str().unwrap().to_owned(),
        )
        .unwrap(),
        device_id: marks_auth::DeviceId::new(browser_device_id.clone()).unwrap(),
        device_key_epoch: 1,
        audience: challenge["audience"].as_str().unwrap().to_owned(),
        challenge: challenge_bytes,
        issued_at_ms: now_ms(),
        expires_at_ms: challenge["expiresAtMs"].as_u64().unwrap() - 1_000,
    };
    let signature = browser_key.sign_p1363(&proof.signing_bytes());
    let redeem_body = json!({
        "proof": {
            "version": 1,
            "challengeId": proof.challenge_id.as_str(),
            "deviceId": browser_device_id,
            "deviceKeyEpoch": 1,
            "audience": proof.audience,
            "challenge": b64(&proof.challenge),
            "issuedAtMs": proof.issued_at_ms,
            "expiresAtMs": proof.expires_at_ms,
        },
        "signature": b64(&signature),
    });
    let redeemed = http
        .post(format!("{base}/v1/auth/device/redeem"))
        .json(&redeem_body)
        .send()
        .await
        .unwrap();
    assert_eq!(redeemed.status(), 201);
    let recovered_cookie = cookie_value(
        redeemed
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );

    // A challenge replay cannot mint a second session.
    let replayed = http
        .post(format!("{base}/v1/auth/device/redeem"))
        .json(&redeem_body)
        .send()
        .await
        .unwrap();
    assert_eq!(replayed.status(), 401);

    // The recovered session opens the same document list.
    let recovered = json_of(
        http.get(format!("{base}/v1/documents"))
            .header("Cookie", &recovered_cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(
        recovered["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|document| document["id"] == document_id.as_str()),
    );

    // 10. A guessed document ID returns no metadata.
    let guessed = http
        .get(format!("{base}/v1/documents/document_guessed1"))
        .header("Cookie", &recovered_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(guessed.status(), 404);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn evt_promotion_transaction_path() {
    // The trusted-adapter seam is exercised through the explicit test shim.
    // SAFETY of env mutation: process-wide, but this test file runs in one
    // process and the flag only widens this feature-flagged endpoint.
    unsafe { std::env::set_var("MARKS_EVT_INSECURE_TEST_ADAPTER", "1") };
    let server = TestServer::spawn(temp_db("evt-flow")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    let scratch = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let scratch_id = scratch["scratchId"].as_str().unwrap().to_owned();
    let capability = scratch["capability"].as_str().unwrap().to_owned();
    let scratch_auth = format!("MarksScratch {scratch_id}.{capability}");

    let browser_key = DeviceKey::generate();
    let device_id = "device_browser_evt01".to_owned();
    http.put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
        .header("Authorization", &scratch_auth)
        .json(&json!({ "deviceId": device_id, "publicKey": b64(&browser_key.public_sec1()) }))
        .send()
        .await
        .unwrap();

    let challenge = json_of(
        http.post(format!("{base}/v1/auth/evt/challenges"))
            .header("Authorization", &scratch_auth)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let nonce = challenge["nonce"].as_str().unwrap().to_owned();
    let redeem = json!({
        "nonce": nonce,
        "evidence": {
            "challengeId": challenge["challengeId"],
            "issuer": "https://issuer.example",
            "canonicalEmail": "person@example.com",
            "audience": challenge["audience"],
            "nonce": nonce,
            "issuedAtMs": now_ms(),
            "adapterVersion": challenge["adapterVersion"],
        },
    });
    let redeemed = http
        .post(format!("{base}/v1/auth/evt/redeem"))
        .header("Authorization", &scratch_auth)
        .json(&redeem)
        .send()
        .await
        .unwrap();
    assert_eq!(redeemed.status(), 201);
    let cookie = cookie_value(
        redeemed
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap(),
    );

    // Nonce/challenge replay fails closed.
    let replay = http
        .post(format!("{base}/v1/auth/evt/redeem"))
        .header("Authorization", &scratch_auth)
        .json(&redeem)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 401);

    let session = http
        .get(format!("{base}/v1/auth/session"))
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(session.status(), 200);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leftover_scratch_header_does_not_hide_a_live_session() {
    let server = TestServer::spawn(temp_db("leftover-scratch")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();
    let principal = common::create_principal(&base, &http, "leftover").await;

    let leftover = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let leftover_auth = format!(
        "MarksScratch {}.{}",
        leftover["scratchId"].as_str().unwrap(),
        leftover["capability"].as_str().unwrap()
    );

    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Cookie", &principal.cookie)
            .header("Origin", &base)
            .header("Authorization", &leftover_auth)
            .json(&json!({ "title": "durable after leftover scratch" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();

    let session_list = json_of(
        http.get(format!("{base}/v1/documents"))
            .header("Cookie", &principal.cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(
        session_list["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|document| document["id"] == document_id)
    );

    let scratch_list = json_of(
        http.get(format!("{base}/v1/documents"))
            .header("Authorization", &leftover_auth)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(
        scratch_list["documents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|document| document["id"] != document_id)
    );

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn four_word_code_promotes_a_scratch_workspace() {
    let server = TestServer::spawn(temp_db("auth-words")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    let scratch = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let scratch_id = scratch["scratchId"].as_str().unwrap().to_owned();
    let capability = scratch["capability"].as_str().unwrap().to_owned();
    let scratch_auth = format!("MarksScratch {scratch_id}.{capability}");

    let browser_key = DeviceKey::generate();
    let browser_device_id = "device_words_browser".to_owned();
    assert_eq!(
        http.put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
            .header("Authorization", &scratch_auth)
            .json(&json!({
                "deviceId": browser_device_id,
                "publicKey": b64(&browser_key.public_sec1())
            }))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );

    let pairing = json_of(
        http.post(format!("{base}/v1/auth/pairings"))
            .header("Authorization", &scratch_auth)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let pairing_id = pairing["pairingId"].as_str().unwrap().to_owned();
    let words = pairing["words"].as_str().unwrap().to_owned();
    assert_eq!(words.split_whitespace().count(), 4);

    let guessed = http
        .post(format!("{base}/v1/auth/pairings/lookup"))
        .json(&json!({ "words": "correct horse battery staple" }))
        .send()
        .await
        .unwrap();
    assert_eq!(guessed.status(), 401);

    let inspect = json_of(
        http.post(format!("{base}/v1/auth/pairings/lookup"))
            .json(&json!({ "words": words }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(inspect["pairingId"], pairing_id.as_str());
    assert_eq!(inspect["scratchId"], scratch_id.as_str());
    assert_eq!(inspect["pendingDeviceId"], browser_device_id.as_str());

    let controller_key = DeviceKey::generate();
    let now = now_ms();
    let bootstrap = marks_auth::ControllerBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_words1").unwrap(),
        controller_device_id: marks_auth::DeviceId::new("device_words_phone").unwrap(),
        controller_public_key_hash: controller_key.public_key_hash(),
        pairing_id: marks_auth::PairingId::new(pairing_id.clone()).unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        pending_device_id: marks_auth::DeviceId::new(browser_device_id.clone()).unwrap(),
        pending_device_public_key_hash: browser_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let signature = controller_key.sign_p1363(&bootstrap.signing_bytes());
    let approved = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/bootstrap"))
        .json(&json!({
            "words": words,
            "bootstrap": {
                "version": 1,
                "controllerId": "controller_words1",
                "controllerDeviceId": "device_words_phone",
                "controllerPublicKeyHash": b64(&bootstrap.controller_public_key_hash),
                "pairingId": pairing_id,
                "scratchId": scratch_id,
                "pendingDeviceId": browser_device_id,
                "pendingDevicePublicKeyHash": b64(&bootstrap.pending_device_public_key_hash),
                "issuedAtMs": now,
                "expiresAtMs": now + 60_000,
            },
            "controllerPublicKey": b64(&controller_key.public_sec1()),
            "signature": b64(&signature),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), 201);

    let finalized = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/finalize"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(finalized.status(), 201);

    server.stop().await;
}
