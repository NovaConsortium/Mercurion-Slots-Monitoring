import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'fs';
import mongoose from 'mongoose';
import { main } from './monitor.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.slashCommands = new Collection();

async function startBot() {
    await client.login(process.env.discordToken);

    const eventFiles = fs.readdirSync('./events').filter(file => file.endsWith('.js'));
    for (const file of eventFiles) {
        const event = await import(`./events/${file}`);
        event.default(client);
    }
    client.on("ready", async () => {
        const arrayOfSlashCommands = await loadSlashCommands();
        console.log(`Ready! Logged in as ${client.user.tag}`);

        await client.application.commands.set([]);

        await client.guilds.cache
            //.get("1322679317787971625")
            .get("732580703447023617")
            .commands.set(arrayOfSlashCommands);
    });

    await mongoose.connect(process.env.mongoUri);

    async function loadSlashCommands() {
        const arrayOfSlashCommands = [];
        const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

        const loadedCommands = await Promise.all(
            commandFiles.map(async (value) => {
                try {
                    const file = await import("./commands/" + value);

                    if (!file.default?.name) return null;

                    const properties = { ...file.default };

                    client.slashCommands.set(file.default.name, properties);
                    if (["MESSAGE", "USER"].includes(file.default.type)) {
                        delete file.default.description;
                    }

                    return file.default;
                } catch (error) {
                    console.error(`Error loading command ${value}:`, error);
                    return null;
                }
            })
        );

        arrayOfSlashCommands.push(...loadedCommands.filter(cmd => cmd !== null));
        return arrayOfSlashCommands;
    }

    await main();

    process.on("unhandledRejection", (reason, p) => {
        console.log("Unhandled Rejection/Catch", reason, p);
    });
    process.on("uncaughtException", (err, origin) => {
        console.log("Uncaught Exception/Catch", err, origin);
    });
}

startBot();

export default client;