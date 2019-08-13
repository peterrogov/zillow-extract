import selenium from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import moment from 'moment';
import gMaps from "@google/maps";

var player = require('play-sound')();

const googleMapsClient = gMaps.createClient({
    key: "AIzaSyBoIP544YKCeEKdTScTG1jLrQZkcU_UKDk",
    Promise
});

async function googleTranslateAddress(address: string): Promise<string> {
    try {
        const res = await googleMapsClient.geocode({ address }).asPromise();
        if (res && res.json && res.json.results && res.json.results.length) {
            const result = res.json.results[0];
            if (result.formatted_address && result.formatted_address.length) {
                return result.formatted_address;
            }
        }
    } catch {

    }

    return "";
}

interface ISearchListingResult {
    address?: string,
    rawAddress?: string,
    url?: string
}

interface IPropertyData {
    inputRow?: number,
    status?: "SUCCESS" | "FAIL" | "GOOGLE-SUCCESS",
    rawAddress?: string,
    extractionTime?: string,
    url?: string,
    address?: string,
    value?: number,
    baths?: number,
    beds?: number,
    area?: number,
    zestimate?: number,
    zestimateRent?: number,
    description?: string,
    facts: IPropertyFact[]
}

interface IPropertyFact {
    label: string,
    value: string
}

let allPropertiesData: IPropertyData[] = [];
let allFailedAddresses: string[] = [];
const options = new firefox.Options();
const dataFile = `./data/data.json`;
let failedFile = "failed.txt";
const outputFile = "./data/output-compiled.csv";
const csvHeaders = "STATUS;ZILLOW ADDRESS;PROPERTY URL;BEDS;BATHS;AREA;ZESTIMATE;ZESTIMATE RENT;VALUE";

type AddrCount = {
    address: string,
    count: number
}

const addrCounts: AddrCount[] = [];

let factsLabels: string[] = [];

let totalItems: number = 0;
let successItems: number = 0;
let failedItems: number = 0;
let startTime = new Date();

const inputFile = './data/input.csv';
const inputHeaders: string[] = [];
const inputRows: string[][] = [];

const driver = new selenium.Builder()
    .setFirefoxOptions(options)
    .forBrowser('firefox')
    .build();

/**
 * async wrapper for internal setTimeout function
 * Usage: let x = await timeoutAsync(100);
 */
const timeoutAsync = (ms: number): Promise<any> => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let alert: any = null;

async function ringAlert() {
    await killAlert();
    alert = player.play('alert.mp3');
}

async function killAlert() {
    if (alert && !alert.killed) {
        alert.kill();
    }
}

async function waitForPageLoad() {
    driver.wait(async function () {
        const readyState = await driver.executeScript('return document.readyState');
        return readyState === 'complete';
    });
}

async function readInputFile() {
    if (!fs.existsSync(inputFile)) {
        console.error("Input file does not exist");
        return;
    }

    const inputLines = await readFileLines(inputFile);

    if (inputLines.length < 2) {
        console.error("Input file must have two or more lines");
        return;
    }

    const headerLine = inputLines[0];
    const headerLineSplit = headerLine.split(';');
    for (let x = 0; x < headerLineSplit.length; x++) {
        const header = headerLineSplit[x].toUpperCase().trim();
        inputHeaders.push(header);
    }

    for (let x = 1; x < inputLines.length; x++) {
        const rowSplit = inputLines[x].split(';');
        if (rowSplit.length !== inputHeaders.length) {
            console.log(`Input line #${x + 1} does not match header column count. Skipping.`);
            continue;
        }

        const inputRowData: string[] = [];
        for (let t = 0; t < rowSplit.length; t++) {
            inputRowData.push(rowSplit[t].trim());
        }

        inputRows.push(inputRowData);
    }
}

async function getSearchResults(type: "RENT" | "BUY", searchQuery: string): Promise<ISearchListingResult[]> {
    let results: ISearchListingResult[] = [];
    try {

        if (type === "BUY") {
            await driver.get(`https://www.zillow.com/homes/for_buy/`);
        } else if (type === "RENT") {
            await driver.get(`https://www.zillow.com/homes/for_rent/`);
        }

        await waitForPageLoad();

        const searchInput = await driver.findElement(selenium.By.css('.react-autosuggest__input'));
        await searchInput.clear();
        await searchInput.sendKeys(`${searchQuery}`);
        await searchInput.sendKeys(selenium.Key.ENTER);

        await timeoutAsync(5000);

        const searchResults = await driver.findElement(selenium.By.id("grid-search-results"));
        //const headerText = await (await searchResults.findElement(selenium.By.tagName("h1"))).getText();
        //const countText = parseInt(await (await searchResults.findElement(selenium.By.className("result-count"))).getText());

        let pageNumber: number = 1;
        let terminate: boolean = false;

        do {
            let pageItems: number = 0;
            console.log(`Processing results page #${pageNumber}`);
            const pageArticles = await searchResults.findElements(selenium.By.css('article.list-card'));
            if (pageArticles && pageArticles.length) {
                for (let x = 0; x < pageArticles.length; x++) {
                    const article = pageArticles[x];
                    try {
                        const title = await (await article.findElement(selenium.By.tagName("h3"))).getText();
                        const anchor = await article.findElement(selenium.By.css("a.list-card-link"));
                        const url = await anchor.getAttribute("href");

                        results.push({
                            url: url
                        });

                        pageItems++;
                    } catch (err) {
                        continue;
                    }
                }
            }

            terminate = true;

            try {
                const paginationItem = await searchResults.findElement(selenium.By.css('li.zsg-pagination-next'));
                const nextPageAnchor = await paginationItem.findElement(selenium.By.tagName('a'));

                if (nextPageAnchor) {
                    console.log(`Added ${pageItems} properties from page ${pageNumber}. Going to the next page`);
                    pageNumber++;
                    await nextPageAnchor.click();
                    console.log('Pause 30 sec.');
                    await timeoutAsync(30000);
                    terminate = false;
                } else {
                    console.log(`Added ${pageItems} properties from page ${pageNumber}. No more pages available`);
                }
            } catch (err) {
                console.log(`Added ${pageItems} properties from page ${pageNumber}. No more pages available`);
            }
        } while (!terminate);

    } catch (err) {
        console.error(err);
    }

    return results;
}

async function propertyExtractAddress(): Promise<string> {
    try {
        let address = await (await driver.findElement(selenium.By.tagName('h1'))).getText();
        address = address.replace(/\n/g, ', ');
        address = address.trim();
        return address;
    } catch (err) {
        return "Unrecognized address"
    }
}

async function propertyExtractValue(): Promise<number | undefined> {
    try {
        const summaryRow = await driver.findElement(selenium.By.css('div.ds-summary-row-content'));
        const valueTag = await summaryRow.findElement(selenium.By.className('ds-value'));
        let valueTagText = await valueTag.getText();
        valueTagText = valueTagText.replace(/,/g, '');
        valueTagText = valueTagText.replace(/\$/g, '');

        const value = parseInt(valueTagText);
        if (isNaN(value)) {
            return undefined;
        } else {
            return value;
        }
    } catch (err) {
        return undefined;
    }
}

async function propertyExtractZestimate(): Promise<number | undefined> {
    const layout1 = async (): Promise<number | undefined> => {
        try {
            const zestimateQuote = await (await driver.findElement(selenium.By.css('.zestimate.primary-quote'))).getText();
            let valueText = zestimateQuote.substring(zestimateQuote.indexOf('$'));
            valueText = valueText.replace(/,/g, '');
            valueText = valueText.replace(/\$/g, '');

            const value = parseInt(valueText);
            if (isNaN(value)) {
                return undefined;
            } else {
                return value;
            }
        } catch (err) {
            return undefined;
        }
    }

    const layout2 = async (): Promise<number | undefined> => {
        try {
            const zestimateQuote = await (await driver.findElement(selenium.By.css(".ds-estimate"))).getText();
            if (zestimateQuote.toUpperCase().indexOf("RENT") >= 0) {
                return undefined;
            }
            let valueText = zestimateQuote.substring(zestimateQuote.indexOf('$'));
            valueText = valueText.replace(/,/g, '');
            valueText = valueText.replace(/\$/g, '');

            const value = parseInt(valueText);
            if (isNaN(value)) {
                return undefined;
            } else {
                return value;
            }
        } catch (err) {
            return undefined;
        }
    }

    let value = await layout1();
    if (value === undefined) {
        value = await layout2();
    }

    return value;
}

async function propertyExtractHeadlineFigure(index: number): Promise<number | undefined> {
    const layout1 = async (): Promise<number | undefined> => {
        try {
            const figures = await driver.findElement(selenium.By.css('.edit-facts-light'));
            const items = await figures.findElements(selenium.By.css('span:not(.middle-dot)'));
            if (items && items.length > index) {
                let val = await items[index].getText();
                const space = val.indexOf(' ');
                if (space > 0) {
                    val = val.substring(0, space);
                }
                val = val.replace(/,/g, '');
                const floatVal = parseFloat(val);
                if (isNaN(floatVal)) {
                    return undefined;
                } else {
                    return floatVal;
                }
            } else {
                return undefined;
            }
        } catch (err) {
            return undefined;
        }
    }

    const layout2 = async (): Promise<number | undefined> => {
        try {
            const figures = await driver.findElements(selenium.By.css('span.ds-bed-bath-living-area'));
            if (figures && figures.length > index) {
                const span = await figures[index].findElement(selenium.By.css('span:not(.ds-summary-row-label-secondary)'));
                let val = await span.getText();
                const space = val.indexOf(' ');
                if (space > 0) {
                    val = val.substring(0, space);
                }
                val = val.replace(/,/g, '');
                const floatVal = parseFloat(val);
                if (isNaN(floatVal)) {
                    return undefined;
                } else {
                    return floatVal;
                }
            } else {
                return undefined;
            }
        } catch (err) {
            return undefined;
        }
    }

    let value = await layout1();
    if (value === undefined) {
        value = await layout2();
    }

    return value;
}

async function propertyExtractZestimateRent(): Promise<number | undefined> {
    const layout1 = async (): Promise<number | undefined> => {
        try {
            const zestimateQuote = await (await driver.findElement(selenium.By.css('.rent-zestimate'))).getText();
            let valueText = zestimateQuote.substring(zestimateQuote.indexOf('$'));
            valueText = valueText.replace(/,/g, '');
            valueText = valueText.replace(/\$/g, '');

            const value = parseInt(valueText);
            if (isNaN(value)) {
                return undefined;
            } else {
                return value;
            }
        } catch (err) {
            return undefined;
        }
    }

    const layout2 = async (): Promise<number | undefined> => {
        try {
            const zestimateQuote = await (await driver.findElement(selenium.By.css(".ds-estimate"))).getText();
            if (zestimateQuote.toUpperCase().indexOf("RENT") < 0) {
                return undefined;
            }
            let valueText = zestimateQuote.substring(zestimateQuote.indexOf('$'));
            valueText = valueText.replace(/,/g, '');
            valueText = valueText.replace(/\$/g, '');

            const value = parseInt(valueText);
            if (isNaN(value)) {
                return undefined;
            } else {
                return value;
            }
        } catch (err) {
            return undefined;
        }
    }

    let value = await layout1();
    if (value === undefined) {
        value = await layout2();
    }

    return value;

}

async function propertyExtractDescription(): Promise<string> {
    try {
        let address = await (await driver.findElement(selenium.By.css(".zsg-content-item.home-description"))).getText();
        address = address.replace(/\n/g, ' ');
        address = address.trim();
        return address;
    } catch (err) {
        return "";
    }
}

async function propertyExtractFacts(): Promise<IPropertyFact[]> {
    const factsCombined: IPropertyFact[] = [];

    const addFact = (factsArray: IPropertyFact[], label: string, value: string) => {
        for (let x = 0; x < factsArray.length; x++) {
            if (factsArray[x].label === label) {
                return;
            }
        }

        factsArray.push({
            label: label.replace(/;/g, ',').toUpperCase(),
            value: value.replace(/;/g, ',')
        });
    }

    const processFact = (factsArray: IPropertyFact[], label: string, value: string) => {
        label = label.trim();

        while (label.endsWith(':')) {
            label = label.substring(0, label.length - 1);
        }

        if (label.toUpperCase() === "FLOOR SIZE") {
            label = "Floor size (sqft.)";
            value = parseInt(value.replace(/,/g, '')).toString()
        }

        if (label.toUpperCase() === "LAST SOLD") {
            const forPos = value.indexOf('for');
            let dateText = value.substring(0, forPos);
            let priceText = parseInt(value.substring(forPos + 5).trim().replace(/,/g, '')).toString();

            addFact(factsArray, "LAST SOLD DATE", dateText.trim());
            addFact(factsArray, "LAST SOLD VALUE", priceText.trim());
        } else {
            addFact(factsArray, label, value);
        }
    }

    const layout1 = async (): Promise<any> => {
        try {
            try {
                const readMore = driver.findElement(selenium.By.css('.home-details-facts-container .read-more a'));
                if (readMore) {
                    await readMore.click();
                    await timeoutAsync(3000);
                }
            } catch (err) {

            }

            const factContainers = await driver.findElements(selenium.By.css('.fact-container'));
            for (let x = 0; x < factContainers.length; x++) {
                const container = factContainers[x];
                try {
                    const label = await container.findElement(selenium.By.css('.fact-label'));
                    const value = await container.findElement(selenium.By.css('.fact-value'));
                    let labelText = await label.getText();
                    let valueText = await value.getText();

                    processFact(factsCombined, labelText, valueText);

                } catch (err) {
                    continue;
                }
            }
        } catch (err) {
            return [];
        }
    }

    const layout2 = async (): Promise<any> => {
        try {
            try {
                const readMore = driver.findElement(selenium.By.css('.home-details-facts-container .read-more a'));
                if (readMore) {
                    await readMore.click();
                    await timeoutAsync(3000);
                }
            } catch (err) { }

            const factContainers = await driver.findElements(selenium.By.css('.ds-home-fact-list-item'));
            for (let x = 0; x < factContainers.length; x++) {
                const container = factContainers[x];
                try {
                    const label = await container.findElement(selenium.By.css('.ds-home-fact-label'));
                    const value = await container.findElement(selenium.By.css('.ds-home-fact-value'));
                    let labelText = await label.getText();
                    let valueText = await value.getText();

                    processFact(factsCombined, labelText, valueText);

                } catch (err) {
                    continue;
                }
            }
        } catch (err) {
            return [];
        }
    }

    const layout3 = async (): Promise<any> => {
        try {
            try {
                const readMore = driver.findElement(selenium.By.css('.home-details-facts-container .read-more a'));
                if (readMore) {
                    await readMore.click();
                    await timeoutAsync(3000);
                }
            } catch (err) {

            }
            try {
                const readMore = driver.findElement(selenium.By.css('a.ds-expandable-card-footer-text.ds-text-button'));
                if (readMore) {
                    await readMore.click();
                    await timeoutAsync(3000);
                }
            } catch (err) { }

            const factContainers = await driver.findElements(selenium.By.tagName('tr'));
            for (let x = 0; x < factContainers.length; x++) {
                const container = factContainers[x];
                try {
                    const cells = await container.findElements(selenium.By.tagName('td'));
                    if (cells.length !== 2) {
                        continue;
                    }

                    const cell1 = cells[0];
                    const cell2 = cells[1];

                    const valueItem = cell2.findElement(selenium.By.css('span.ds-home-fact-value'));

                    if (!valueItem) {
                        continue;
                    }

                    let valueText = await valueItem.getText();
                    let labelText = await cell1.getText();

                    processFact(factsCombined, labelText, valueText);

                } catch (err) {
                    continue;
                }
            }
        } catch (err) {
            return [];
        }
    }

    await layout1();
    await layout2();
    await layout3();

    console.log(`Extracted ${factsCombined.length} facts for this item`);

    return factsCombined;
}

async function extractPropertyData(property: ISearchListingResult): Promise<IPropertyData | null> {
    const propertyData: IPropertyData = { facts: [] };
    if (property.url) {
        await driver.get(property.url);
    } else if (property.address) {
        await driver.get(`https://www.zillow.com/`);
        await waitForPageLoad();
        propertyData.rawAddress = property.rawAddress ? property.rawAddress : property.address;
        const searchInput = await driver.findElement(selenium.By.css('.react-autosuggest__input'));
        await searchInput.clear();
        await searchInput.sendKeys(`${property.address}`);
        await searchInput.sendKeys(selenium.Key.ENTER);
    } else {
        return null;
    }

    await timeoutAsync(15000);

    let captchaCycle = 0;
    while ((await driver.getCurrentUrl()).toLowerCase().includes("captcha")) {
        if (captchaCycle === 0) {
            console.log('Waiting for captcha to be resolved');
            await ringAlert();
        }
        await timeoutAsync(5000);
        captchaCycle++;
    }

    await killAlert();

    let hasHomeDetails = false;
    try {
        const homeDetails = await driver.findElement(selenium.By.id("home-details-content"));
        if (homeDetails) {
            hasHomeDetails = true;
        }
    } catch (err) {
        hasHomeDetails = false;
    }

    if (!hasHomeDetails) {
        return null;
    }

    propertyData.url = await driver.getCurrentUrl();
    propertyData.address = await propertyExtractAddress();
    propertyData.value = await propertyExtractValue();
    propertyData.zestimate = await propertyExtractZestimate();
    propertyData.zestimateRent = await propertyExtractZestimateRent();
    propertyData.beds = await propertyExtractHeadlineFigure(0);
    propertyData.baths = await propertyExtractHeadlineFigure(1);
    propertyData.area = await propertyExtractHeadlineFigure(2);
    //propertyData.description = await propertyExtractDescription();
    propertyData.facts = await propertyExtractFacts();

    propertyData.extractionTime = new Date().toUTCString();

    return propertyData;
}

async function main() {
    await driver.manage().window().setRect({ width: 900, height: 900 });

    console.clear();
    console.log('Zillow Extract v.1.0 by Peter Rogov');

    /*
    if (process.argv.length < 2) {
        console.error("Input file name is required");
        return;
    }
    */

    await readInputFile();

    if (!inputHeaders.length || !inputRows.length) {
        console.log('No input data available.');
        return;
    }

    const inputAddressColumn = inputHeaders.indexOf('NORMALIZED ADDRESS');
    if (inputAddressColumn === -1) {
        console.log('Input file does not contain NORMALIZED ADDRESS column.');
        return;
    }

    let dataDirFiles = fs.readdirSync('./data/');
    const failedFiles: string[] = [];
    for (let r = 0; r < dataDirFiles.length; r++) {
        const file = dataDirFiles[r];
        if (file.startsWith('failed') && file.endsWith(".txt")) {
            failedFiles.push(file);
        }
    }

    for (let z = 0; z < failedFiles.length; z++) {
        let f = await readFileLines(`./data/${failedFiles[z]}`);
        for (let t = 0; t < f.length; t++) {
            allFailedAddresses.push(f[t].toUpperCase().trim());
        }
    }

    if (allFailedAddresses.length) {
        console.log(`Loaded ${allFailedAddresses.length} failed records from previous run`);
    }

    if (fs.existsSync(dataFile)) {
        const json = fs.readFileSync(dataFile).toString();
        allPropertiesData = JSON.parse(json);
        console.log(`Loaded ${allPropertiesData.length} records from previous run`);

        let deletedCount = 0;
        for (let t = 0; t < allPropertiesData.length; t++) {
            let isFound = false;
            for (let x = 0; x < inputRows.length; x++) {
                const address = inputRows[x][inputAddressColumn];
                if (allPropertiesData[t].rawAddress === address) {
                    isFound = true;
                    break;
                }
            }

            if (!isFound) {
                allPropertiesData.splice(t, 1);
                t = -1;
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            console.log(`Deleted ${deletedCount} records from the dataset as they are not present in the input`);
        }
    }

    await processAddresses();

    let finishTime = new Date();

    await driver.quit();

    console.log("Generating final CSV");
    factsLabels = [];
    for (let x = 0; x < allPropertiesData.length; x++) {
        const factsCombined = allPropertiesData[x].facts;
        for (let z = 0; z < factsCombined.length; z++) {
            if (!factsLabels.includes(factsCombined[z].label)) {
                factsLabels.push(factsCombined[z].label);
            }
        }
    }

    factsLabels = factsLabels.sort();

    fs.writeFileSync(outputFile, getCsvHeaderLine() + "\n");
    for (let x = 0; x < allPropertiesData.length; x++) {
        const propertyCsv = getPropertyCsvLine(allPropertiesData[x]);
        fs.appendFileSync(outputFile, propertyCsv + "\n");
    }

    let sm = moment(startTime);
    let fm = moment(finishTime);

    console.log();

    failedItems = 0;
    successItems = 0;
    for (let x = 0; x < allPropertiesData.length; x++) {
        if (allPropertiesData[x].status === "SUCCESS" || allPropertiesData[x].status === "GOOGLE-SUCCESS") {
            successItems++;
        } else {
            failedItems++;
        }
    }

    console.log("\n=== Processing stats ===\n");
    console.log("Total items:", allPropertiesData.length);
    console.log("Failed items:", failedItems);
    console.log("Success items:", successItems);
    console.log(`Success rate: ${((successItems / totalItems) * 100).toFixed(2)}%`);
    console.log(`Processing time: ${fm.diff(sm, "hours", true).toFixed(2)} hrs.`);
    console.log();
    console.log('Zillow Extract finished');
}

async function processAddresses() {

    const inputAddressColumn = inputHeaders.indexOf('NORMALIZED ADDRESS');
    if (inputAddressColumn === -1) {
        console.log('Input file does not contain NORMALIZED ADDRESS column.');
        return;
    }

    console.log(`Processing ${inputRows.length} records from input`);
    failedFile = `./data/failed.txt`;
    for (let x = 0; x < inputRows.length; x++) {
        const address = inputRows[x][inputAddressColumn];
        console.log(`[${x + 1}/${inputRows.length}] Extracting property data from ${address}`);

        totalItems++;

        let propertyData = findDataByRawAddress(address);

        if (propertyData) {
            propertyData.inputRow = x;
            if (propertyData.status === "SUCCESS" || propertyData.status === "GOOGLE-SUCCESS") {
                console.log('This address is already processed. Skipping.');
                successItems++;

            } else {
                console.log('This address has failed previously. Skipping.');
                failedItems++;
            }
            continue;
        }
        let retryWithGoogle = false;
        let keepTrying = true;

        do {
            let extractAddress = address;
            if (retryWithGoogle) {
                extractAddress = await googleTranslateAddress(address);
                if (!address.length) {
                    keepTrying = false;
                    break;
                }
            }

            try {
                propertyData = await extractPropertyData({ address: extractAddress, rawAddress: address });
                if (propertyData) {
                    propertyData.inputRow = x;
                    propertyData.status = retryWithGoogle ? "GOOGLE-SUCCESS" : "SUCCESS";
                    keepTrying = false;
                } else {
                    propertyData = {
                        inputRow: x,
                        rawAddress: address,
                        status: "FAIL",
                        facts: []
                    }
                }
            } catch (err) {
                console.log(`Error: ${err.message}`);
                console.log(`Retrying item in 5 sec.`);
                await timeoutAsync(5000);
                continue;
            }

            if (!propertyData || propertyData.status === "FAIL") {
                console.log('Could not extract property data');
                if(!retryWithGoogle){
                    console.log('Trying to decode address with google maps and retry');
                    retryWithGoogle = true;
                }else{
                    propertyData = {
                        inputRow: x,
                        rawAddress: address,
                        status: "FAIL",
                        facts: []
                    }
                    keepTrying = false;
                }
            }else if(propertyData.status === "GOOGLE-SUCCESS"){
                console.log("Property data extracted after decode by google");
            }
        } while (keepTrying);

        allPropertiesData.push(propertyData);

        const propJson = JSON.stringify(allPropertiesData, null, 2);
        fs.writeFileSync(dataFile, propJson);

        console.log('Property data saved OK');
    }
}

async function readFileLines(file: string): Promise<string[]> {
    const lines: string[] = [];
    const stream = fs.createReadStream(file);
    const readInterface = readline.createInterface({ input: stream });
    let finished = false;
    readInterface.on("line", (line) => {
        const lineTrim = line.trim();
        lines.push(lineTrim);
    });

    readInterface.on("close", () => {
        finished = true;
    });

    while (!finished) {
        await timeoutAsync(100);
    }

    return lines;
}

function findDataByRawAddress(addr: string): IPropertyData | null {
    for (let x = 0; x < allPropertiesData.length; x++) {
        if (allPropertiesData[x].rawAddress) {
            if (allPropertiesData[x].rawAddress.toUpperCase().trim() === addr.toUpperCase().trim()) {
                return allPropertiesData[x];
            }
        }
    }

    return null;
}


function getCsvHeaderLine(): string {

    let headerLine = inputHeaders.join(';') + ";" + csvHeaders;

    if (factsLabels.length > 0) {
        headerLine += ';' + factsLabels.join(";");
    }

    return headerLine;
}

function getPropertyCsvLine(property: IPropertyData): string {
    const csvColumns: string[] = [];

    if (property.inputRow === undefined) {
        return "";
    }

    for (let x = 0; x < inputRows[property.inputRow].length; x++) {
        csvColumns.push(inputRows[property.inputRow][x]);
    }

    const data = [
        property.status ? property.status : "UNKNOWN",
        property.address ? property.address : "",
        property.url ? property.url : "",
        property.beds !== undefined ? property.beds.toString() : "",
        property.baths !== undefined ? property.baths.toString() : "",
        property.area !== undefined ? property.area.toString() : "",
        property.zestimate !== undefined ? property.zestimate.toString() : "",
        property.zestimateRent !== undefined ? property.zestimateRent.toString() : "",
        property.value !== undefined ? property.value.toString() : "",
    ];

    for (let x = 0; x < data.length; x++) {
        csvColumns.push(data[x]);
    }

    for (let x = 0; x < factsLabels.length; x++) {
        const label = factsLabels[x];
        let isFound: boolean = false;

        for (let z = 0; z < property.facts.length; z++) {
            if (property.facts[z].label.toUpperCase().trim() === label.toUpperCase().trim()) {
                csvColumns.push(property.facts[z].value);
                isFound = true;
                break;
            }
        }

        if (!isFound) {
            csvColumns.push('');
        }
    }

    return csvColumns.join(';');
}

main();