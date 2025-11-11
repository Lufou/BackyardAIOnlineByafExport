#!/usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const fs = require("fs");
const path = require("path");
const { createByaArchive, byafCharacterSchema, byafScenarioSchema } = require("byaf");
const { SUPPORTED_BROWSERS, loadCookies } = require("./cookies.js");
const { debugLog, infoLog, warnLog, errorLog } = require("./logging.js");
const { downloadImageAsFile, replaceStringSpecial, parseBrowserString } = require("./utils.js");
const { Requester } = require("./Requester.js");
const os = require("os");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

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
    .option('cookies', {
        alias: 'c',
        type: 'string',
        description: 'Provide cookies as a string',
        default: null,
    })
    .help()
    .argv;

const OUTPUT_DIR = argv['output-dir'];
const DEBUG = argv.debug;
const EXIT_ON_FAILURE = argv['exit-on-failure'];

module.exports = { DEBUG };

(async () => {
    let cookies = argv.cookies;
    if (!argv.cookies) {
        let browser = argv.browser
        if (!browser) {
            try {
                if (os.platform() === "win32") {
                    const { stdout } = await exec(
                        'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId'
                    );

                    const match = stdout.match(/ProgId\s+REG_SZ\s+(.+)/);
                    if (match) browser = match[1];
                } else if (os.platform() === "darwin") {
                    const { stdout } = await exec(
                        'defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers -array'
                    );
                    browser = stdout;
                } else {
                    const { stdout } = await exec('xdg-settings get default-web-browser');
                    browser = stdout;
                }
            } catch (err) {
                errorLog(err);
            }

            browser = browser.toLowerCase();
            for (const supported_browser of SUPPORTED_BROWSERS) {
                if (browser.includes(supported_browser)) {
                    browser = supported_browser;
                    break;
                }
            }
        }

        if (!browser) {
            warnLog("Could not determine default browser. Please specify the browser manually.");
            return null;
        }

        const [browserName, profile, keyring, container] = parseBrowserString(browser);
        debugLog(`Using browser: ${browserName}`);
        cookies = await loadCookies([browserName, profile, keyring, container, "backyard.ai"]);
    }
    if (!cookies) {
        return;
    }
    debugLog(`Cookies found: ${cookies.length}`);
    let all_fetched = false;
    let cursor = 0;
    const requester = new Requester(BASE_URL, cookies);
    infoLog("Fetching all characters...");
    let preloadCharacters = [];
    while (!all_fetched) {
        const response = await requester.makeRequest(`/api/trpc/app.groupConfig.getAll?batch=1&input={"0":{"json":{"folderUrl":null,"cursor":${cursor},"direction":"forward"}}}`, "fetch characters");

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
        infoLog(`\nProcessing: ${char.displayName} (${char.id})`);

        const requestScenarios = await requester.makeRequest(`/api/trpc/app.groupConfig.getScenarios?batch=1&input={"0":{"json":{"groupConfigId":"${char.id}"}}}`, "fetch scenarios");

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

            const requestChat = await requester.makeRequest(`/api/trpc/app.groupConfig.getByChatId?batch=1&input={"0":{"json":{"chatId":"${scenarioId}"}}}`, "fetch chat info");

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
                    const messagesRequest = await requester.makeRequest(`/api/trpc/app.chat.getMessages?batch=1&input={"0":{"json":{"chatId":"${scenarioId}","direction":"forward","cursor":${cursor}}}}`, "fetch messages");

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
            errorLog("Error while creating archive:", error);
        } else {
            infoLog(`✅ ${outputPath} created`);
        }
    }

    infoLog("\n✅ Finished!");
})();
