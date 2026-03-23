export function stringToSingleJsonBlock(input: string){
    const firstBrace = input.indexOf('{');
    const lastBrace = input.lastIndexOf('}');

    // Ensure both braces exist and the first comes before the last
    if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
        return input.substring(firstBrace, lastBrace + 1);
    }

    return null;
}