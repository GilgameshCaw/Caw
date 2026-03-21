const CawNameURI = artifacts.require("CawNameURI");

contract("CawNameURI", (accounts) => {
  it("should generate URI for 'gilgamesh'", async () => {
    const uri = await CawNameURI.new();
    const result = await uri.generate("gilgamesh");

    // result is a data URI: data:application/json;base64,...
    const jsonBase64 = result.replace("data:application/json;base64,", "");
    const json = JSON.parse(Buffer.from(jsonBase64, "base64").toString());

    console.log("\n=== Token Metadata ===");
    console.log("Name:", json.name);
    console.log("Description:", json.description);

    // Decode the SVG
    const svgBase64 = json.image.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(svgBase64, "base64").toString();

    console.log("\n=== SVG Output ===");
    console.log(svg);

    // Write SVG to file for visual inspection
    const fs = require("fs");
    fs.writeFileSync(__dirname + "/test-gilgamesh.svg", svg);
    console.log("\nSVG written to test/test-gilgamesh.svg");

    assert.equal(json.name, "gilgamesh");
  });
});
