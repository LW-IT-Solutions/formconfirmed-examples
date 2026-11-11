const repo = "LW-IT-Solutions/formconfirmed-examples";
const outcome = process.env.CHECK_OUTCOME;
const token = process.env.GH_TOKEN;
if (!token || !["success", "failure"].includes(outcome) || process.env.GITHUB_REPOSITORY !== repo) process.exit(2);
const run = process.env.GITHUB_RUN_ID;
if (!/^[0-9]{1,20}$/.test(run || "")) process.exit(2);
const title = "Availability check failing";
const runUrl = "https://github.com/" + repo + "/actions/runs/" + run;
async function api(path, method = "GET", body) {
  const response = await fetch("https://api.github.com/repos/" + repo + path, {
    method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: {Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", ...(body ? {"Content-Type": "application/json"} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (response.status === 422 && path === "/labels") return null;
  if (!response.ok) throw Error("incident request failed");
  return response.status === 204 ? null : response.json();
}
(async () => {
  await api("/labels", "POST", {name: "availability", color: "B60205", description: "External formconfirmed availability checks"});
  const issues = await api("/issues?state=open&labels=availability&per_page=20");
  if (!Array.isArray(issues)) throw Error("incident schema");
  const issue = issues.find(i => i.title === title && i.user?.login === "github-actions[bot]" && !i.pull_request && Number.isSafeInteger(i.number));
  if (outcome === "failure" && !issue) {
    await api("/issues", "POST", {title, labels: ["availability"],
      body: "The external formconfirmed availability check failed. No visitor or customer data was used.\n\nCheck the service and the [workflow run](" + runUrl + ")."});
    console.log("Availability incident opened.");
  } else if (outcome === "success" && issue) {
    await api("/issues/" + issue.number + "/comments", "POST", {body: "The external availability check passed again. [Workflow run](" + runUrl + ")."});
    await api("/issues/" + issue.number, "PATCH", {state: "closed", state_reason: "completed"});
    console.log("Availability incident resolved.");
  } else {
    console.log("Availability incident state unchanged.");
  }
})().catch(() => { console.error("Availability incident update failed."); process.exitCode = 1; });
