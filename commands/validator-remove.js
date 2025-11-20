import { ContainerBuilder, MessageFlags, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";
import validatorSubscriptionSchema from "../schema/validatorSubscriptions.js";

export default {
    name: "validator-remove",
    description: "Stop tracking a validator",
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

        console.log(validatorAddress);
        let info = await fetch(`https://api.thevalidators.io/validators/list?network=mainnet&select=voteId,validatorId,svName,keybaseUsername,iconUrl,name,nodeVersion&vote_id=${validatorAddress}`);
        info = await info.json();
        info = info.data[0];

        console.log(info);
        if (!info) {
            return interaction.reply({ content: `**Invalid validator vote address provided.**`, ephemeral: true });
        }

        const existingSubscription = await validatorSubscriptionSchema.findOne({ validatorAddress: info.validatorId });
        
        if (!existingSubscription) {
            return interaction.reply({ content: `**This validator is not subscribed in any channel.**`, ephemeral: true });
        }

        const subscriptionIndex = existingSubscription.subscriptions.findIndex(
            sub => sub.serverId === interaction.guild.id && sub.channelId === interaction.channel.id
        );

        if (subscriptionIndex === -1) {
            return interaction.reply({ content: `**This validator is not subscribed in this server and channel.**`, ephemeral: true });
        }

        existingSubscription.subscriptions.splice(subscriptionIndex, 1);

        if (existingSubscription.subscriptions.length === 0) {
            await validatorSubscriptionSchema.deleteOne({ validatorAddress: info.validatorId });
        } else {
            await existingSubscription.save();
        } 

        const container = new ContainerBuilder();
        const text = new TextDisplayBuilder()
            .setContent(`### <:cross:1399399676696068127> Removed ${info.name} from subscriptions.`);

        container.addTextDisplayComponents(text);

        const text2 = new TextDisplayBuilder()
            .setContent(`\`🪪\` **Vote ID:** ${info.voteId}\n\`🔗\` **Validator ID:** ${info.validatorId}\n\`⚙️\` **Version:** ${info.nodeVersion}`);

        const section2 = new SectionBuilder()
            .addTextDisplayComponents(text2)
            .setThumbnailAccessory(
                new ThumbnailBuilder()
                    .setURL(info.iconUrl || "https://media.discordapp.net/attachments/1366369127953989692/1399394706504290555/svgviewer-png-output.png?ex=6888d761&is=688785e1&hm=e84e858015909eff2a5c3d90be542059c3fa56d4bfd78b6530861e3720c06451&=&format=webp&quality=lossless")
            );

        container.addSectionComponents(section2);

        return interaction.reply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },
};
