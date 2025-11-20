import { getMainnetList } from '../validatorList.js';
import validatorSubscriptionSchema from '../schema/validatorSubscriptions.js';
import validatorDMSubscriptionSchema from '../schema/validatorDMSubscriptions.js';


export default (client) => {
    client.on("interactionCreate", async (interaction) => {
        
        if (interaction.isChatInputCommand()) {
            const cmd = client.slashCommands.get(interaction.commandName);
            if (!cmd) return interaction.reply({ content: `**Something went Wrong! Please Report This To A Staff Member**`, ephemeral: true });

            const args = [];

            for (let option of interaction.options.data) {
                if (option.type === "SUB_COMMAND") {
                    if (option.name) args.push(option.name);
                    option.options?.forEach((x) => {
                        if (x.value) args.push(x.value);
                    });
                } else if (option.value) args.push(option.value);
            }
            interaction.member = interaction.guild.members.cache.get(
                interaction.user.id
            );
            function checkPerms(permission) {
                return interaction.member.permissions.has(permission)
            }
            if (cmd.userPermissions && cmd.userPermissions.every(checkPerms) == false) {
                interaction.reply({ content: `**You Don't Have Enough Permission**`, ephemeral: true });
            } else if (cmd) {
                cmd.run(client, interaction, args)
            }
        }

        if (interaction.type === 4) { 
            switch (interaction.commandName) {
                case 'validator-add':
                    const text = interaction.options.getString('validator');
                    const validatorList = getMainnetList();

                    if (!text) {
                        return interaction.respond(validatorList.map(choice => ({
                            name: choice.name || "Unknown Validator",
                            value: choice.voteId
                        })).slice(0, 25)).catch(err => {
                            console.log(err.message);
                        });
                    } else {
                        const filtered = validatorList.filter(x =>
                            x.name.toLowerCase().includes(text.toLowerCase())
                        )

                        await interaction.respond(
                            filtered.map(choice => ({
                                name: choice.name,
                                value: choice.voteId
                            })).slice(0, 25)
                        ).catch(err => {
                            console.log("add-validator autocomplete error", err.message)
                        })
                    }
                case 'validator-remove':
                    const text2 = interaction.options.getString('validator');

                    try {
                        const trackedValidators = await validatorSubscriptionSchema.find({
                            'subscriptions.serverId': interaction.guild.id,
                            'subscriptions.channelId': interaction.channel.id
                        });

                        if (trackedValidators.length === 0) {
                            return interaction.respond([{
                                name: "No validators tracked in this channel",
                                value: "none"
                            }]).catch(err => console.log("remove-validator autocomplete error 1", err.message));
                        }

                        const validatorChoices = [];
                        const validatorList2 = getMainnetList();

                        for (const validator of trackedValidators) {
                            try {
                                const validatorInfo = validatorList2.find(v => v.validatorId === validator.validatorAddress);

                                if (validatorInfo) {
                                    const name = validatorInfo.name || validator.validatorAddress.slice(0, 8) + "...";

                                    if (!text2 || name.toLowerCase().includes(text2.toLowerCase())) {
                                        validatorChoices.push({
                                            name: name,
                                            value: validatorInfo.voteId
                                        });
                                    }
                                }
                            } catch (error) {
                                const name = validator.validatorAddress.slice(0, 8) + "...";
                                if (!text2 || name.toLowerCase().includes(text2.toLowerCase())) {
                                    validatorChoices.push({
                                        name: name,
                                        value: validatorInfo.voteId
                                    });
                                }
                            }
                        }

                        await interaction.respond(
                            validatorChoices.slice(0, 25)
                        ).catch(err => {
                            console.log("remove-validator autocomplete error", err.message)
                        });

                    } catch (error) {
                        console.error('Error in remove-validator autocomplete:', error);
                        await interaction.respond([{
                            name: "Error loading tracked validators",
                            value: "error"
                        }]).catch(err => console.log(err.message));
                    }
                    break;
                case 'stats-dm-add':
                    const text3 = interaction.options.getString('name');
                    const validatorList3 = getMainnetList();

                    if (!text3) {
                        return interaction.respond(validatorList3.map(choice => ({
                            name: choice.name || "Unknown Validator",
                            value: choice.voteId
                        })).slice(0, 25)).catch(err => {
                            console.log(err.message);
                        });
                    } else {
                        const filtered = validatorList3.filter(x =>
                            x.name.toLowerCase().includes(text3.toLowerCase())
                        )

                        await interaction.respond(
                            filtered.map(choice => ({
                                name: choice.name,
                                value: choice.voteId
                            })).slice(0, 25)
                        ).catch(err => {
                            console.log("dm-validator-stats autocomp err", err.message)
                        })

                    }
                    break;
                case 'stats-dm-remove':
                    const text4 = interaction.options.getString('name');

                    try {
                        const trackedValidators = await validatorDMSubscriptionSchema.find({
                            'subscribers.userId': interaction.user.id
                        });

                        if (trackedValidators.length === 0) {
                            return interaction.respond([{
                                name: "No validators tracked in DMs",
                                value: "none"
                            }]).catch(err => console.log(err.message));
                        }

                        const validatorChoices = [];
                        const validatorList4 = getMainnetList();

                        for (const validator of trackedValidators) {
                            try {
                                const validatorInfo = validatorList4.find(v => v.validatorId === validator.validatorAddress);

                                if (validatorInfo) {
                                    const name = validatorInfo.name || validator.validatorAddress.slice(0, 8) + "...";

                                    if (!text4 || name.toLowerCase().includes(text4.toLowerCase())) {
                                        validatorChoices.push({
                                            name: name,
                                            value: validatorInfo.voteId
                                        });
                                    }
                                }
                            } catch (error) {
                                const name = validator.validatorAddress.slice(0, 8) + "...";
                                if (!text4 || name.toLowerCase().includes(text4.toLowerCase())) {
                                    validatorChoices.push({
                                        name: name,
                                        value: validatorInfo.voteId
                                    });
                                }
                            }
                        }

                        await interaction.respond(
                            validatorChoices.slice(0, 25)
                        ).catch(err => {
                            console.log(err.message)
                        });

                    } catch (error) {
                        console.error('Error in remove-validator autocomplete:', error);
                        await interaction.respond([{
                            name: "Error loading tracked validators",
                            value: "error"
                        }]).catch(err => console.log(err.message));
                    }
                    break;
                case 'stats-message':
                    const text5 = interaction.options.getString('validator');
                    const validatorList5 = getMainnetList();

                    if (!text5) {
                        return interaction.respond(validatorList5.map(choice => ({
                            name: choice.name || "Unknown Validator",
                            value: choice.voteId
                        })).slice(0, 25)).catch(err => {
                            console.log(err.message);
                        });
                    } else {
                        const filtered = validatorList5.filter(x =>
                            x.name.toLowerCase().includes(text5.toLowerCase())
                        )

                        await interaction.respond(
                            filtered.map(choice => ({
                                name: choice.name,
                                value: choice.voteId
                            })).slice(0, 25)
                        ).catch(err => {
                            console.log("add-validator autocomplete error", err.message)
                        })
                    }
                case 'validator-info':
                const text6 = interaction.options.getString('validator');
                const validatorList6 = getMainnetList();

                if (!text6) {
                    return interaction.respond(
                        validatorList6.map(choice => ({
                            name: choice.name || "Unknown Validator",
                            value: choice.voteId
                        })).slice(0, 25)
                    ).catch(err => {
                        console.log(err.message);
                    });
                } else {
                    const filtered = validatorList6.filter(x =>
                        x.name.toLowerCase().includes(text6.toLowerCase())
                    );

                    await interaction.respond(
                        filtered.map(choice => ({
                            name: choice.name,
                            value: choice.voteId
                        })).slice(0, 25)
                    ).catch(err => {
                        console.log("validator-info autocomplete error", err.message)
                    });
                }
                break;
            }

        }
    })
}
