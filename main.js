#!/usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const fs = require("fs");
const path = require("path");
const { createByaArchive, byafCharacterSchema, byafScenarioSchema } = require("byaf");
const { getCookiesForDomain } = require("./cookies_extractor.js");
const { debugLog } = require("./logging.js");
const { downloadImageAsFile, replaceStringSpecial } = require("./utils.js");
const { Requester } = require("./Requester.js");

const BASE_URL = "https://backyard.ai";

const argv = yargs(hideBin(process.argv))
    .option('debug', {
        alias: ['d', 'verbose'],
        type: 'boolean',
        description: 'Enable debug mode',
        default: false,
    })
    .option('output-dir', {
        alias: 'o',
        type: 'string',
        description: 'Force output directory',
        default: './output',
    })
    .option('exit-on-failure', {
        alias: 'e',
        type: 'boolean',
        description: 'Exit on failure',
        default: true,
    })
    .option('browser', {
        alias: 'b',
        type: 'string',
        description: 'Specify the browser to extract cookies from (chrome, firefox, edge, brave, safari, opera)',
        default: null,
    })
    .option('messages', {
        alias: 'm',
        type: 'boolean',
        description: 'Export chat messages',
        default: false,
    })
    .help()
    .argv;

const OUTPUT_DIR = argv['output-dir'];
const DEBUG = argv.debug;
const EXIT_ON_FAILURE = argv['exit-on-failure'];

module.exports = { DEBUG };

(async () => {
    const cookies = await getCookiesForDomain("backyard.ai", argv.browser);
    if (!cookies) {
        return;
    }
    debugLog(`Cookies found: ${cookies.length}`);
    let all_fetched = false;
    let cursor = 0;
    const requester = new Requester(BASE_URL, cookies);
    console.log("Fetching all characters...");
    let preloadCharacters = [];
    while (!all_fetched) {
        const response = await requester.makeRequest(`/api/trpc/app.groupConfig.getAll?batch=1&input={"0":{"json":{"folderUrl":null,"cursor":${cursor},"direction":"forward"}}}`);

        if (!response) {
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

    debugLog(`${preloadCharacters.length} characters found.`);

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
    
    for (let char of preloadCharacters) {
        console.log(`\nProcessing: ${char.displayName} (${char.id})`);

        const requestScenarios = await requester.makeRequest(`/api/trpc/app.groupConfig.getScenarios?batch=1&input={"0":{"json":{"groupConfigId":"${char.id}"}}}`);

        if (!requestScenarios) {
            if (EXIT_ON_FAILURE) {
                return;
            }
            continue;
        }

        const scenarios = requestScenarios.scenarios;

        let definitiveScenarios = [];

        for (const scenario of scenarios) {
            debugLog(`Treating scenario ${scenario.id}`);

            const scenarioId = scenario.id;

            const requestChat = await requester.makeRequest(`/api/trpc/app.groupConfig.getByChatId?batch=1&input={"0":{"json":{"chatId":"${scenarioId}"}}}`);

            if (!requestChat) {
                if (EXIT_ON_FAILURE) {
                    return;
                }
                continue;
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

            let messages = [];

            if (argv.messages) {
                let all_fetched = false;
                let cursor = 0;
                let incr = 0;
                while (!all_fetched) {
                    const messagesRequest = await requester.makeRequest(`/api/trpc/app.chat.getMessages?batch=1&input={"0":{"json":{"chatId":"${scenarioId}","direction":"forward","cursor":${cursor}}}}`);

                    if (!messagesRequest) {
                        if (EXIT_ON_FAILURE) {
                            return;
                        }
                    } else {
                        if (incr === 0) {
                            incr = messagesRequest.nextCursor;
                        }
                        for (const msg of messagesRequest.messages) {
                            let toAdd = {};
                            toAdd.type = msg.type;
                            if (msg.type === "ai") {
                                toAdd.outputs = [];
                                toAdd.outputs.push({ createdAt: msg.activeTimestamp, updatedAt: msg.activeTimestamp, text: msg.text, activeTimestamp: msg.activeTimestamp });
                            } else {
                                toAdd.type = "human";
                                toAdd.createdAt = msg.activeTimestamp;
                                toAdd.updatedAt = msg.activeTimestamp;
                                toAdd.text = msg.text;
                            }
                            messages.push(toAdd);
                        }
                    }

                    if (messagesRequest.messages.length < incr) {
                        all_fetched = true;
                    } else {
                        cursor = messagesRequest.nextCursor;
                    }
                }
                messages = messages.reverse();
                debugLog(`${messages.length} messages`);
            }

            const primaryChat = chatInfo.primaryChat;

            if (chatInfo.isNSFW) {
                char.isNSFW = true;
            }
            
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
                messages: messages,
                backgroundImage: primaryChat.BackgroundImages[0] ? await downloadImageAsFile(primaryChat.BackgroundImages[0].imageUrl) : "",
            }

            definitiveScenarios.push(scenarioToAdd);
        }
        const outputPath = path.join(OUTPUT_DIR, `${char.id}.byaf`);

        debugLog(`character data: ${JSON.stringify(char)}`);
        debugLog(`scenario data: ${JSON.stringify(definitiveScenarios)}`);

        let error = null;
        const characterResult = byafCharacterSchema.omit({ images: true }).safeParse(char);
        if (!characterResult.success) {
            error = `Invalid character data: ${characterResult.error.message}`;
        }
        else if (char.id === "") {
            error = "Character ID is required";
        }
        else {
            for (const scenario of definitiveScenarios) {
                const scenarioResult = byafScenarioSchema.omit({ backgroundImage: true }).safeParse(scenario);
                if (!scenarioResult.success) {
                    error = `Invalid scenario data: ${scenarioResult.error.message}`;
                }
            }
        }
        
        if (!error) {
            error = await createByaArchive(
                {
                    outputPath,
                    character: char,
                    scenarios: definitiveScenarios,
                },
                {
                    validateInputs: false,
                },
            ).error;
        }
        
        if (error) {
            console.error("Error while creating archive:", error);
        } else {
            console.log(`✅ ${outputPath} created`);
        }
    }

    console.log("\n✅ Finished!");
})();
