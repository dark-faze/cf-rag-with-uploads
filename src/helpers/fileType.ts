//@ts-nocheck


const isUrl = (text: string): boolean => {
    try {
        new URL(text);
        return true;
    } catch (error) {
        return false;
    }
};

const isPdfLink = (text: string): boolean => {
    return text.toLowerCase().endsWith('.pdf');
};


export { 
    isUrl,
    isPdfLink
};