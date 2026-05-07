const { MongoClient } = require('mongodb');

async function main() {
    const uri = "mongodb+srv://manthand917:Manthan9049981809@cluster0.cv6zmaw.mongodb.net/";
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db("inspectra_meta");
        
        const session = await db.collection("sessions").findOne({ sessionId: "SES-1777463604560" });
        console.log(JSON.stringify(session, null, 2));
    } catch (e) {
        console.error("Database error:", e);
    } finally {
        await client.close();
    }
}

main();
