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

/// The visitor's only device is the phone that holds the scratch workspace:
/// scratch → pending device → single-device self-bootstrap → controller
/// session on that same phone. A laptop that appears later joins the same
/// principal through the ordinary QR pairing, approved by the phone.
#[tokio::test(flavor = "multi_thread")]
async fn phone_only_self_bootstrap_lifecycle() {
    let server = TestServer::spawn(temp_db("self-bootstrap")).await;
    let http = reqwest::Client::new();
    let base = server.base.clone();

    // 1. The phone tab mints an ordinary scratch capability and binds its key.
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

    let phone_key = DeviceKey::generate();
    let phone_device_id = "device_phone_solo1".to_owned();
    assert_eq!(
        http.put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
            .header("Authorization", &scratch_auth)
            .json(&json!({
                "deviceId": phone_device_id,
                "publicKey": b64(&phone_key.public_sec1())
            }))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );

    // 2. Scratch documents exist before any principal.
    let created = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Authorization", &scratch_auth)
            .json(&json!({ "title": "phone notes" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let document_id = created["document"]["id"].as_str().unwrap().to_owned();

    // 3. A forged signature is refused before any state changes.
    let now = now_ms();
    let statement = marks_auth::SelfBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_solo1").unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        device_id: marks_auth::DeviceId::new(phone_device_id.clone()).unwrap(),
        device_public_key_hash: phone_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let statement_json = json!({
        "version": 1,
        "controllerId": "controller_solo1",
        "scratchId": scratch_id,
        "deviceId": phone_device_id,
        "devicePublicKeyHash": b64(&statement.device_public_key_hash),
        "issuedAtMs": now,
        "expiresAtMs": now + 60_000,
    });
    let attacker_key = DeviceKey::generate();
    let forged = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&json!({
            "bootstrap": statement_json,
            "signature": b64(&attacker_key.sign_p1363(&statement.signing_bytes())),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), 401);

    // 4. The pending key signs its own promotion. No pairing, no second device.
    let signature = phone_key.sign_p1363(&statement.signing_bytes());
    let bootstrap_body = json!({
        "bootstrap": statement_json,
        "signature": b64(&signature),
    });
    let promoted = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&bootstrap_body)
        .send()
        .await
        .unwrap();
    assert_eq!(promoted.status(), 201);
    let phone_cookie = cookie_value(
        promoted
            .headers()
            .get("set-cookie")
            .expect("phone session cookie")
            .to_str()
            .unwrap(),
    );
    let promoted = json_of(promoted).await;
    let principal_id = promoted["principalId"].as_str().unwrap().to_owned();
    assert!(principal_id.starts_with("principal_"));
    assert_eq!(promoted["deviceId"], phone_device_id.as_str());

    // A replay against the claimed scratch fails closed and does not create a
    // second principal.
    let replay = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&bootstrap_body)
        .send()
        .await
        .unwrap();
    assert!(replay.status() == 401 || replay.status() == 409);

    // The scratch capability no longer holds pre-claim authority.
    let stale = http
        .get(format!("{base}/v1/documents"))
        .header("Authorization", &scratch_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 401);

    // 5. The claimed document follows the principal; the phone key is a
    //    controller-capable device.
    let list = json_of(
        http.get(format!("{base}/v1/documents"))
            .header("Cookie", &phone_cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(
        list["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|document| document["id"] == document_id.as_str()),
        "claimed document follows the principal"
    );

    let inventory = json_of(
        http.get(format!("{base}/v1/auth/devices"))
            .header("Cookie", &phone_cookie)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let devices = inventory["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 1, "one physical device, one device row");
    assert_eq!(devices[0]["deviceId"], phone_device_id.as_str());
    assert_eq!(
        devices[0]["capabilities"].as_i64().unwrap(),
        i64::from(marks_auth::DeviceCapabilities::CONTROLLER.bits())
    );
    let controllers = inventory["controllers"].as_array().unwrap();
    assert_eq!(controllers.len(), 1);
    assert_eq!(controllers[0]["deviceId"], phone_device_id.as_str());

    // 6. Later, a laptop shows up with its own scratch and QR pairing. The
    //    phone approves it into the same principal with a signed grant.
    let laptop = json_of(
        http.post(format!("{base}/v1/auth/scratch"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let laptop_scratch_id = laptop["scratchId"].as_str().unwrap().to_owned();
    let laptop_capability = laptop["capability"].as_str().unwrap().to_owned();
    let laptop_auth = format!("MarksScratch {laptop_scratch_id}.{laptop_capability}");

    let laptop_key = DeviceKey::generate();
    let laptop_device_id = "device_laptop_solo".to_owned();
    assert_eq!(
        http.put(format!("{base}/v1/auth/scratch/{laptop_scratch_id}/device"))
            .header("Authorization", &laptop_auth)
            .json(&json!({
                "deviceId": laptop_device_id,
                "publicKey": b64(&laptop_key.public_sec1())
            }))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let laptop_document = json_of(
        http.post(format!("{base}/v1/documents"))
            .header("Authorization", &laptop_auth)
            .json(&json!({ "title": "laptop notes" }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let laptop_document_id = laptop_document["document"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let pairing = json_of(
        http.post(format!("{base}/v1/auth/pairings"))
            .header("Authorization", &laptop_auth)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let pairing_id = pairing["pairingId"].as_str().unwrap().to_owned();
    let pairing_secret = pairing["secret"].as_str().unwrap().to_owned();

    let controller_id = controllers[0]["controllerId"].as_str().unwrap().to_owned();
    let now = now_ms();
    let grant = marks_auth::DeviceGrant {
        version: 1,
        principal_id: marks_auth::PrincipalId::new(principal_id.clone()).unwrap(),
        controller_id: marks_auth::ControllerId::new(controller_id.clone()).unwrap(),
        controller_epoch: 1,
        pairing_id: marks_auth::PairingId::new(pairing_id.clone()).unwrap(),
        scratch_id: marks_auth::ScratchId::new(laptop_scratch_id.clone()).unwrap(),
        pending_device_id: marks_auth::DeviceId::new(laptop_device_id.clone()).unwrap(),
        pending_device_public_key_hash: laptop_key.public_key_hash(),
        capabilities: marks_auth::DeviceCapabilities::MEMBER,
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let grant_signature = phone_key.sign_p1363(&grant.signing_bytes());
    let approved = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/approve"))
        .header("Cookie", &phone_cookie)
        .header("Origin", &base)
        .json(&json!({
            "secret": pairing_secret,
            "grant": {
                "version": 1,
                "principalId": principal_id,
                "controllerId": controller_id,
                "controllerEpoch": 1,
                "pairingId": pairing_id,
                "scratchId": laptop_scratch_id,
                "pendingDeviceId": laptop_device_id,
                "pendingDevicePublicKeyHash": b64(&grant.pending_device_public_key_hash),
                "capabilities": grant.capabilities.bits(),
                "issuedAtMs": now,
                "expiresAtMs": now + 60_000,
            },
            "signature": b64(&grant_signature),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), 200);

    let finalized = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/finalize"))
        .header("Authorization", &laptop_auth)
        .send()
        .await
        .unwrap();
    assert_eq!(finalized.status(), 201);
    let laptop_cookie = cookie_value(
        finalized
            .headers()
            .get("set-cookie")
            .expect("laptop session cookie")
            .to_str()
            .unwrap(),
    );
    let finalized = json_of(finalized).await;
    assert_eq!(finalized["principalId"], principal_id.as_str());

    // 7. Both devices see both documents: one principal, no merge, no second
    //    account.
    for cookie in [&phone_cookie, &laptop_cookie] {
        let list = json_of(
            http.get(format!("{base}/v1/documents"))
                .header("Cookie", cookie)
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
        assert!(ids.contains(&document_id.as_str()));
        assert!(ids.contains(&laptop_document_id.as_str()));
    }

    server.stop().await;
}

/// A self-bootstrap statement that does not match the bound pending device,
/// or that arrives after a pairing already claimed the scratch, fails closed.
#[tokio::test(flavor = "multi_thread")]
async fn self_bootstrap_rejects_mismatch_and_claimed_scratch() {
    let server = TestServer::spawn(temp_db("self-bootstrap-closed")).await;
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

    let device_key = DeviceKey::generate();
    let device_id = "device_closed_solo".to_owned();
    assert_eq!(
        http.put(format!("{base}/v1/auth/scratch/{scratch_id}/device"))
            .header("Authorization", &scratch_auth)
            .json(&json!({
                "deviceId": device_id,
                "publicKey": b64(&device_key.public_sec1())
            }))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );

    // A statement naming a different device than the bound pending key fails
    // even with a valid signature from that other key.
    let other_key = DeviceKey::generate();
    let now = now_ms();
    let mismatched = marks_auth::SelfBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_closed1").unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        device_id: marks_auth::DeviceId::new("device_substitute").unwrap(),
        device_public_key_hash: other_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let response = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&json!({
            "bootstrap": {
                "version": 1,
                "controllerId": "controller_closed1",
                "scratchId": scratch_id,
                "deviceId": "device_substitute",
                "devicePublicKeyHash": b64(&mismatched.device_public_key_hash),
                "issuedAtMs": now,
                "expiresAtMs": now + 60_000,
            },
            "signature": b64(&other_key.sign_p1363(&mismatched.signing_bytes())),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    // An expired statement fails closed.
    let expired = marks_auth::SelfBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_closed2").unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        device_id: marks_auth::DeviceId::new(device_id.clone()).unwrap(),
        device_public_key_hash: device_key.public_key_hash(),
        issued_at_ms: now - 120_000,
        expires_at_ms: now - 60_000,
    };
    let response = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&json!({
            "bootstrap": {
                "version": 1,
                "controllerId": "controller_closed2",
                "scratchId": scratch_id,
                "deviceId": device_id,
                "devicePublicKeyHash": b64(&expired.device_public_key_hash),
                "issuedAtMs": now - 120_000,
                "expiresAtMs": now - 60_000,
            },
            "signature": b64(&device_key.sign_p1363(&expired.signing_bytes())),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    // A pairing promotion claims the scratch first; the self-bootstrap that
    // races in afterwards must not create a second principal.
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
    let controller_key = DeviceKey::generate();
    let now = now_ms();
    let bootstrap = marks_auth::ControllerBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_closed3").unwrap(),
        controller_device_id: marks_auth::DeviceId::new("device_closed_phone").unwrap(),
        controller_public_key_hash: controller_key.public_key_hash(),
        pairing_id: marks_auth::PairingId::new(pairing_id.clone()).unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        pending_device_id: marks_auth::DeviceId::new(device_id.clone()).unwrap(),
        pending_device_public_key_hash: device_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let signature = controller_key.sign_p1363(&bootstrap.signing_bytes());
    let approved = http
        .post(format!("{base}/v1/auth/pairings/{pairing_id}/bootstrap"))
        .json(&json!({
            "secret": pairing_secret,
            "bootstrap": {
                "version": 1,
                "controllerId": "controller_closed3",
                "controllerDeviceId": "device_closed_phone",
                "controllerPublicKeyHash": b64(&bootstrap.controller_public_key_hash),
                "pairingId": pairing_id,
                "scratchId": scratch_id,
                "pendingDeviceId": device_id,
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

    let late = marks_auth::SelfBootstrap {
        version: 1,
        controller_id: marks_auth::ControllerId::new("controller_closed4").unwrap(),
        scratch_id: marks_auth::ScratchId::new(scratch_id.clone()).unwrap(),
        device_id: marks_auth::DeviceId::new(device_id.clone()).unwrap(),
        device_public_key_hash: device_key.public_key_hash(),
        issued_at_ms: now,
        expires_at_ms: now + 60_000,
    };
    let response = http
        .post(format!("{base}/v1/auth/scratch/{scratch_id}/bootstrap"))
        .header("Authorization", &scratch_auth)
        .json(&json!({
            "bootstrap": {
                "version": 1,
                "controllerId": "controller_closed4",
                "scratchId": scratch_id,
                "deviceId": device_id,
                "devicePublicKeyHash": b64(&late.device_public_key_hash),
                "issuedAtMs": now,
                "expiresAtMs": now + 60_000,
            },
            "signature": b64(&device_key.sign_p1363(&late.signing_bytes())),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401, "claimed scratch fails closed");

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
