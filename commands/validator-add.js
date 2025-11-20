import { ContainerBuilder, MessageFlags, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";
import validatorSubscriptionSchema from "../schema/validatorSubscriptions.js";
import { getMainnetList } from "../validatorList.js";

export default {
    name: "validator-add",
    description: "Start tracking a validator slots",
    options: [
        {
            name: 'validator',
            description: 'The Validator Name OR Vote Address',
            type: 3,
            required: true,
            autocomplete: true
        }
    ],
    run: async (client, interaction, args) => {
        if (!interaction.member.permissions.has("ManageGuild")) return interaction.reply({ content: `<:cross:1399399676696068127> **You do not have permission to use this command.**`, ephemeral: true });
        const validatorAddress = interaction.options.getString('validator');
        const validatorList = getMainnetList();

        let info = validatorList.find(v => v.voteId === validatorAddress);
        console.log(info);
        if (!info) {
            return interaction.reply({ content: `**Invalid validator vote address provided.**`, ephemeral: true });
        }

        const container = new ContainerBuilder();
        const text = new TextDisplayBuilder()
            .setContent(`### <:tick:1399117596749598801> Added [${info.name}](https://solscan.io/account/${validatorAddress}) to subscriptions.`);

        container.addTextDisplayComponents(text);

        const text2 = new TextDisplayBuilder()
            .setContent(`\`🪪\` **Vote ID:** ${info.voteId}\n\`🔗\` **Validator ID:** ${info.validatorId}\n\`⚙️\` **Version:** ${info.nodeVersion}\n-# Tips are only calculated after the validator was added`);

        const section2 = new SectionBuilder()
            .addTextDisplayComponents(text2)
            .setThumbnailAccessory(
                new ThumbnailBuilder()
                    .setURL(info.iconUrl || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png?ex=6888d761&is=688785e1&hm=e84e858015909eff2a5c3d90be542059c3fa56d4bfd78b6530861e3720c06451&=&format=webp&quality=lossless")
            );

        container.addSectionComponents(section2);

        const existingSubscription = await validatorSubscriptionSchema.findOne({ validatorAddress: info.validatorId });
        if (existingSubscription) {
            const subIndex = existingSubscription.subscriptions.findIndex(
                sub =>
                    sub.serverId === interaction.guild.id &&
                    sub.channelId === interaction.channel.id
            );

            if (subIndex !== -1) {
                if (existingSubscription.subscriptions[subIndex].normalStatus) {
                    return interaction.reply({
                        content: `**This validator is already subscribed in this server and channel.**`,
                        ephemeral: true
                    });
                }

                existingSubscription.subscriptions[subIndex].normalStatus = true;
                existingSubscription.subscriptions[subIndex].createdBy = interaction.user.id;
                existingSubscription.subscriptions[subIndex].channelId = interaction.channel.id;

            } else {
                existingSubscription.subscriptions.push({
                    serverId: interaction.guild.id,
                    channelId: interaction.channel.id,
                    addedAt: new Date(),
                    createdBy: interaction.user.id,
                    normalStatus: true
                });
            }

            await existingSubscription.save();

            return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
        } else {
            const newSubscription = new validatorSubscriptionSchema({
                validatorAddress: info.validatorId,
                validatorVoteAddress: info.voteId,
                subscriptions: [{
                    serverId: interaction.guild.id,
                    channelId: interaction.channel.id,
                    addedAt: new Date(),
                    createdBy: interaction.user.id,
                    normalStatus: true
                }]
            });

            await newSubscription.save();

            return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
        }
    },
};