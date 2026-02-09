#!/usr/bin/env bun
import { loadTokensFromDisk, getCachedToken } from "../token-api";

async function testNYU() {
  await loadTokensFromDisk();
  
  const email = "eh2889@nyu.edu";
  const token = await getCachedToken(email);
  
  if (!token) {
    console.error("No token for", email);
    process.exit(1);
  }
  
  const authToken = token.superhumanToken?.token;
  if (!authToken) {
    console.error("No superhumanToken for", email);
    process.exit(1);
  }
  
  console.log(`Testing ${email}\n`);
  
  const response = await fetch("https://mail.superhuman.com/~backend/v3/userdata.getThreads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { type: "draft" },
      offset: 0,
      limit: 25,
    }),
  });

  console.log("Status:", response.status);
  const data = await response.json();
  console.log("\nResponse:");
  console.log(JSON.stringify(data, null, 2));
}

testNYU();
