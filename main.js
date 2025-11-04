const fs = require("fs");
const path = require("path");
const { createByaArchive } = require("byaf");
const { getCookiesForDomain } = require("./cookies_extractor.js");
const { debugLog } = require("./logging.js");
const { downloadImageAsFile, replaceStringSpecial } = require("./utils.js");
const { Requester } = require("./Requester.js");

const BASE_URL = "https://backyard.ai";
const OUTPUT_DIR = "./output";

const DEBUG = false;

(async () => {
    const cookies = getCookiesForDomain("backyard.ai");
    if (!cookies) {
        return;
    }
    debugLog(`Cookies found: ${cookies.length}`, DEBUG);
    let all_fetched = false;
    let cursor = 0;
    const requester = new Requester(BASE_URL, cookies);
    console.log("Fetching all characters...");
    let preloadCharacters = [];
    while (!all_fetched) {
        const response = await requester.makeRequest(`/api/trpc/app.groupConfig.getAll?batch=1&input={"0":{"json":{"folderUrl":null,"cursor":${cursor},"direction":"forward"}}}`);

        if (!request) {
            return;
        }
        
        const fetchedCharacters = response.groupConfigCards;
        for (const char of fetchedCharacters) {
            if (char.CharConfigs.length > 1) {
                for (const config of char.CharConfigs) {
                    preloadCharacters.push({
                        displayName: config.displayName,
                        configId: config.charConfigId,
                        id: char.id
                    });
                }
            } else {
                preloadCharacters.push({
                    displayName: char.CharConfigs[0].displayName,
                    configId: char.CharConfigs[0].charConfigId,
                    id: char.id
                });
            }
        }
        if (fetchedCharacters.length < 50) {
            all_fetched = true;
        } else {
            cursor += 50;
        }
    }

    debugLog(`${preloadCharacters.length} characters found.`, DEBUG);

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
    
    for (let char of preloadCharacters) {
        console.log(`\nProcessing: ${char.displayName} (${char.id})`);

        const requestScenarios = await requester.makeRequest(`/api/trpc/app.groupConfig.getScenarios?batch=1&input={"0":{"json":{"groupConfigId":"${char.id}"}}}`);

        if (!requestScenarios) {
            // TODO: Exit on failure or not
            return;
        }

        const scenarios = requestScenarios.scenarios;

        let definitiveScenarios = [];

        for (const scenario of scenarios) {
            debugLog(`Treating scenario ${scenario.id}`, DEBUG);

            const scenarioId = scenario.id;

            const requestChat = await requester.makeRequest(`/api/trpc/app.groupConfig.getByChatId?batch=1&input={"0":{"json":{"chatId":"${scenarioId}"}}}`);

            if (!requestChat) {
                // TODO: Exit on failure or not
                return;
            }

            const chatInfo = requestChat.frontendGroupConfig;

            for (const config of chatInfo.aiCharacterConfigs) {
                if (config.characterConfigId == char.configId && char.displayName == config.displayName) {
                    char.schemaVersion = 1;
                    char.id = config.id;
                    char.name = config.name;
                    char.isNSFW = config.isNSFW;
                    char.persona = replaceStringSpecial(config.persona, char.configId);
                    char.createdAt = config.createdAt;
                    char.updatedAt = config.updatedAt;
                    char.loreItems = config.LoreItems.map(item => ({
                        key: item.key,
                        value: item.value
                    }));
                    char.images = [];
                    for (const img of config.Images) {
                        const file = await downloadImageAsFile(img.imageUrl);
                        char.images.push({
                            file,
                            label: img.label || "",
                        });
                    }
                    break;
                }
            }

            const primaryChat = chatInfo.primaryChat;

            let scenarioToAdd = {
                schemaVersion: 1,
                title: primaryChat.name,
                formattingInstructions: primaryChat.modelInstructions.customText,
                minP: parseFloat(primaryChat.minP),
                minPEnabled: primaryChat.minPEnabled,
                temperature: parseFloat(primaryChat.temperature),
                repeatPenalty: parseFloat(primaryChat.repeatPenalty),
                repeatLastN: parseInt(primaryChat.repeatLastN),
                topK: parseFloat(primaryChat.topK),
                topP: parseFloat(primaryChat.topP),
                exampleMessages: primaryChat.exampleMessages.map(msg => ({
                    characterID: msg.characterConfigId,
                    text: replaceStringSpecial(msg.text, char.configId)
                })),
                canDeleteExampleMessages: primaryChat.canDeleteCustomDialogue,
                firstMessages: primaryChat.firstMessage ? [{
                    characterID: primaryChat.firstMessage.characterConfigId,
                    text: replaceStringSpecial(primaryChat.firstMessage.text, char.configId)
                }] : [],
                narrative: replaceStringSpecial(primaryChat.context, char.configId),
                promptTemplate: primaryChat.promptTemplate,
                grammar: primaryChat.grammar,
                messages: [],
                backgroundImage: primaryChat.BackgroundImages[0] ? await downloadImageAsFile(primaryChat.BackgroundImages[0].imageUrl) : "",
            }

            definitiveScenarios.push(scenarioToAdd);
        }
        const outputPath = path.join(OUTPUT_DIR, `${char.id}.byaf`);

        debugLog(`character data: ${JSON.stringify(char)}`, DEBUG);
        debugLog(`scenario data: ${JSON.stringify(definitiveScenarios)}`, DEBUG);
        const result = await createByaArchive(
            {
                outputPath,
                character: char,
                scenarios: definitiveScenarios,
            },
            {
                validateInputs: false,
            },
        );

        if (result.error) {
            console.error("Error while creating archive:", result.error);
        } else {
            console.log(`✅ ${outputPath} created`);
        }
    }

    console.log("\n✅ Finished!");
})();
