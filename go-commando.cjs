#!/usr/bin/env node

const { spawn } = require("child_process");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime() {
    return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function runImplement() {
    return new Promise((resolve, reject) => {
        const claude = spawn(`claude -p /${process.argv[2]}`, [], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
        });

        let output = "";
        let errorOutput = "";

        function checkForFailures() {
            for (const o of [output, errorOutput]) {
                if (o.includes("Error: No messages returned")) {
                    console.log(
                        "Killing zombie process due to 'No messages returned' error.",
                    );

                    claude.kill();
                    resolve(0);
                }
                if (o.includes("NO_REMAINING_WORK")) {
                    console.log(
                        "\n✅ No remaining work detected. Exiting with success.\n",
                    );
                    process.exit(0);
                }
            }
        }

        // Capture and display stdout
        claude.stdout.on("data", (data) => {
            const chunk = data.toString();
            output += chunk;
            process.stdout.write(chunk);
            checkForFailures();
        });

        // Capture and display stderr
        claude.stderr.on("data", (data) => {
            const chunk = data.toString();
            errorOutput += chunk;
            process.stderr.write(chunk);
            checkForFailures();
        });

        claude.on("close", (code) => {
            console.log(`\nProcess exited with code: ${code}`);
            resolve(code);
        });

        claude.on("error", (err) => {
            console.error(`\n❌ Failed to start Claude Code: ${err.message}\n`);
            reject(err);
        });
    });
}

const minFailSleep = 5 * 60 * 1000; // 5 minutes
const maxFailSleep = 40 * 60 * 1000; // 40 minutes

async function handleFailureSleep(failSleep) {
    console.log(
        `[${formatTime()}] Sleeping for ${Math.round(failSleep / 60000)} minutes due to failure...`,
    );
    await sleep(failSleep);
    return Math.min(failSleep * 2, maxFailSleep);
}

async function main() {
    console.log(`[${formatTime()}] Press Ctrl+C to stop\n`);

    let iteration = 0;
    let failSleep = minFailSleep;

    while (true) {
        iteration++;
        console.log(`\n${"=".repeat(80)}`);
        console.log(`[${formatTime()}] Iteration ${iteration}`);
        console.log(`${"=".repeat(80)}\n`);

        let code = -1;

        try {
            code = await runImplement();
        } catch (err) {
            console.error(
                `\n[${formatTime()}] ❌ Error during implementation:`,
                err,
            );
            failSleep = await handleFailureSleep(failSleep);
            continue;
        }

        if (code === 1) {
            failSleep = await handleFailureSleep(failSleep);
        } else {
            console.log(
                `\n[${formatTime()}] Iteration ${iteration} succeeded. Continuing in 5 seconds...`,
            );
            failSleep = minFailSleep;
            await sleep(5000);
        }
    }
}

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
    console.log(`\n\n[${formatTime()}] Interrupted by user. Exiting...`);
    process.exit(0);
});

main().catch((err) => {
    console.error(`\n[${formatTime()}] Fatal error:`, err);
    process.exit(1);
});
