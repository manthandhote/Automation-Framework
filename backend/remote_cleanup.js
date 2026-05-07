const { MongoClient } = require('mongodb');

async function main() {
    const uri = "mongodb://nido:nido%40123@192.168.1.59:27017/?authMechanism=DEFAULT";
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db("inspectra_meta");
        
        const running = await db.collection("sessions").find({ status: "RUNNING" }).toArray();
        console.log(`Found ${running.length} running sessions:`, running.map(s => s.sessionId));

        const result = await db.collection("sessions").updateMany(
            { status: "RUNNING" },
            { $set: { status: "FAILED", completedAt: new Date() } }
        );
        console.log(`Updated ${result.modifiedCount} sessions to FAILED.`);
    } catch (e) {
        console.error("Database error:", e);
    } finally {
        await client.close();
    }
}

main();
