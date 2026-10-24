const http = require("http");

async function request(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body,
                });
            });
        });
        req.on("error", reject);
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function run() {
    console.log("1. Logging in as admin...");
    const loginRes = await request({
        hostname: "localhost",
        port: 3001,
        path: "/test-auth/login-as-admin",
        method: "GET",
    });

    const cookieHeader = loginRes.headers["set-cookie"];
    const cookie = cookieHeader ? cookieHeader.map(c => c.split(";")[0]).join("; ") : "";
    console.log("Admin session cookie:", cookie);

    console.log("\n2. Loading /admin/coupons...");
    const couponsPageRes = await request({
        hostname: "localhost",
        port: 3001,
        path: "/admin/coupons",
        method: "GET",
        headers: { Cookie: cookie },
    });
    console.log("Coupons Page Status:", couponsPageRes.statusCode);

    console.log("\n3. Testing POST /admin/coupons/create with form urlencoded body (standard browser form submission)...");
    const params = new URLSearchParams({
        code: "WELCOME20",
        description: "Welcome discount",
        discountType: "PERCENTAGE",
        discountValue: "20",
        minPurchase: "500",
        maxDiscount: "",
        usageLimit: "",
        perUserLimit: "1",
        startDate: "2026-10-24",
        endDate: "2026-10-31",
    });

    const createRes = await request({
        hostname: "localhost",
        port: 3001,
        path: "/admin/coupons/create",
        method: "POST",
        headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(params.toString()),
        },
    }, params.toString());

    console.log("Create Status:", createRes.statusCode);
    console.log("Create Location:", createRes.headers.location);
    console.log("Create Body (first 200 chars):", createRes.body.substring(0, 200));

    console.log("\n4. Checking if WELCOME20 exists on /admin/coupons...");
    const checkPageRes = await request({
        hostname: "localhost",
        port: 3001,
        path: "/admin/coupons",
        method: "GET",
        headers: { Cookie: cookie },
    });
    console.log("Is WELCOME20 in HTML?", checkPageRes.body.includes("WELCOME20"));

    console.log("\n5. Testing POST with invalid payload (e.g. discountValue: 95%, which service rejects > 90%)...");
    const invalidParams = new URLSearchParams({
        code: "WELCOME95",
        description: "95% discount",
        discountType: "PERCENTAGE",
        discountValue: "95",
        minPurchase: "0",
        maxDiscount: "",
        usageLimit: "",
        perUserLimit: "1",
        startDate: "2026-10-24",
        endDate: "2026-10-31",
    });

    const invalidRes = await request({
        hostname: "localhost",
        port: 3001,
        path: "/admin/coupons/create",
        method: "POST",
        headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(invalidParams.toString()),
        },
    }, invalidParams.toString());

    console.log("Invalid Create Status:", invalidRes.statusCode);
    console.log("Invalid Create Location:", invalidRes.headers.location);

    console.log("\n6. Checking if WELCOME95 exists on /admin/coupons...");
    const checkInvalidRes = await request({
        hostname: "localhost",
        port: 3001,
        path: "/admin/coupons",
        method: "GET",
        headers: { Cookie: cookie },
    });
    console.log("Is WELCOME95 in HTML?", checkInvalidRes.body.includes("WELCOME95"));
    console.log("Does the page show any error message for WELCOME95 rejection?", checkInvalidRes.body.includes("Percentage discount cannot exceed"));
}

run().catch(console.error);
