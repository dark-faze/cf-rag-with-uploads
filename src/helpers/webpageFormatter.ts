// @ts-nocheck


function extractTextContent($) {
    // Remove unwanted elements
    $('style, script, noscript, iframe, svg').remove();

    // Function to recursively extract text from an element and its children
    function extractFromElement(element) {
        let text = '';

        if (element.type === 'text') {
            return $(element).text().trim();
        }

        if (element.children && element.children.length > 0) {
            element.children.forEach((child) => {
                let childText = extractFromElement(child);
                if (childText) {
                    text += childText + ' ';
                }
            });
        }

        // Check for specific attributes that might contain valuable text
        const altText = $(element).attr('alt');
        const titleText = $(element).attr('title');
        if (altText) text += altText + ' ';
        if (titleText) text += titleText + ' ';

        return text.trim();
    }

    // Extract text from body
    let allText = $('body')
        .find('*')
        .map(function () {
            return extractFromElement(this);
        })
        .get()
        .filter((text) => text && text.length > 0);

    // Add any text directly under body
    allText.push(
        $('body')
            .contents()
            .filter(function () {
                return this.type === 'text';
            })
            .text()
            .trim()
    );

    return allText.filter((text) => text.length > 0);
}

export { 
    extractTextContent 
};