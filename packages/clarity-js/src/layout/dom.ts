import { Privacy } from "@clarity-types/core";
import { Code, Setting, Severity } from "@clarity-types/data";
import { Constant, Mask, type NodeInfo, type NodeMeta, type NodeValue, Selector, type SelectorInput, Source } from "@clarity-types/layout";
import config from "@src/core/config";
import { bind } from "@src/core/event";
import hash from "@src/core/hash";
import { shortid } from "@src/data/metadata";
import * as internal from "@src/diagnostic/internal";
import { removeObserver } from "@src/layout/node";
import * as region from "@src/layout/region";
import * as selector from "@src/layout/selector";
let index = 1;
let nodesMap: Map<number, Node> = null; // Maps id => node to retrieve further node details using id.
let values: NodeValue[] = [];
let updateMap: number[] = [];
let hashMap: { [hash: string]: number } = {};
let override = [];
let unmask = [];
let maskText = [];
let maskExclude = [];
let maskDisable = [];
let maskTags = [];

// The WeakMap object is a collection of key/value pairs in which the keys are weakly referenced
let idMap: WeakMap<Node, number> = null; // Maps node => id.
let iframeMap: WeakMap<Document, HTMLIFrameElement> = null; // Maps iframe's contentDocument => parent iframe element
let iframeContentMap: WeakMap<HTMLIFrameElement, { doc: Document; win: Window }> = null; // Maps parent iframe element => iframe's contentDocument & contentWindow
let privacyMap: WeakMap<Node, Privacy> = null; // Maps node => Privacy (enum)
let fraudMap: WeakMap<Node, number> = null; // Maps node => FraudId (number)

export function start(): void {
    reset();
    parse(document, true);
}

export function stop(): void {
    reset();
}

function reset(): void {
    index = 1;
    values = [];
    updateMap = [];
    hashMap = {};
    override = [];
    unmask = [];
    maskText = Mask.Text.split(Constant.Comma);
    maskExclude = Mask.Exclude.split(Constant.Comma);
    maskDisable = Mask.Disable.split(Constant.Comma);
    maskTags = Mask.Tags.split(Constant.Comma);
    nodesMap = new Map();
    idMap = new WeakMap();
    iframeMap = new WeakMap();
    iframeContentMap = new WeakMap();
    privacyMap = new WeakMap();
    fraudMap = new WeakMap();
    selector.reset();
}

// We parse new root nodes for any regions or masked nodes in the beginning (document) and
// later whenever there are new additions or modifications to DOM (mutations)
export function parse(root: ParentNode, init = false): void {
    // Wrap selectors in a try / catch block.
    // It's possible for script to receive invalid selectors, e.g. "'#id'" with extra quotes, and cause the code below to fail
    try {
        if (init) {
             // Parse unmask configuration into separate query selectors and override tokens as part of initialization
            for (const x of config.unmask) {
                if (x.indexOf(Constant.Bang) < 0) {
                    unmask.push(x);
                } else {
                    override.push(x.substr(1));
                }
            }
        }

        // Since mutations may happen on leaf nodes too, e.g. text nodes, which may not support all selector APIs.
        // We ensure that the root note supports querySelectorAll API before executing the code below to identify new regions.
        if ("querySelectorAll" in root) {
            for (const x of config.regions) {
                for (const e of Array.from(root.querySelectorAll(x[1]))) {
                    region.observe(e, `${x[0]}`);
                }
            }
            for (const x of config.mask) {
                for (const e of Array.from(root.querySelectorAll(x))) {
                    privacyMap.set(e, Privacy.TextImage);
                }
            } 
            for (const x of config.checksum) {
                for (const e of Array.from(root.querySelectorAll(x[1]))) {
                    fraudMap.set(e, x[0]);
                }
            }
            for (const x of unmask) {
                for (const e of Array.from(root.querySelectorAll(x))) {
                    privacyMap.set(e, Privacy.None);
                }
            }
        }
    } catch (e) {
        internal.log(Code.Selector, Severity.Warning, e ? e.name : null);
    }
}

export function getId(node: Node, autogen = false): number {
    if (node === null) {
        return null;
    }
    let id = idMap.get(node);
    if (!id && autogen) {
        id = index++;
        idMap.set(node, id);
    }

    return id ? id : null;
}

export function add(node: Node, parent: Node, data: NodeInfo, source: Source): void {
    const parentId = parent ? getId(parent) : null;

    // Do not add detached nodes
    if ((!parent || !parentId) && (node as ShadowRoot).host == null && node.nodeType !== Node.DOCUMENT_TYPE_NODE) {
        return;
    }

    const id = getId(node, true);
    const previousId = getPreviousId(node);
    let parentValue: NodeValue = null;
    let regionId = region.exists(node) ? id : null;
    let fraudId = fraudMap.has(node) ? fraudMap.get(node) : null;
    let privacyId = config.content ? Privacy.Sensitive : Privacy.TextImage;
    if (parentId >= 0 && values[parentId]) {
        parentValue = values[parentId];
        parentValue.children.push(id);
        regionId = regionId === null ? parentValue.region : regionId;
        fraudId = fraudId === null ? parentValue.metadata.fraud : fraudId;
        privacyId = parentValue.metadata.privacy;
    }

    // If there's an explicit region attribute set on the element, use it to mark a region on the page
    if (data.attributes && Constant.RegionData in data.attributes) {
        region.observe(node, data.attributes[Constant.RegionData]);
        regionId = id;
    }

    nodesMap.set(id, node);
    values[id] = {
        id,
        parent: parentId,
        previous: previousId,
        children: [],
        data,
        selector: null,
        hash: null,
        region: regionId,
        metadata: { active: true, suspend: false, privacy: privacyId, position: null, fraud: fraudId, size: null },
    };

    privacy(node, values[id], parentValue);
    updateSelector(values[id]);
    updateImageSize(values[id]);
    track(id, source);
}

export function update(node: Node, parent: Node, data: NodeInfo, source: Source): void {
    const id = getId(node);
    const parentId = parent ? getId(parent) : null;
    const previousId = getPreviousId(node);
    let changed = false;
    let parentChanged = false;

    if (id in values) {
        const value = values[id];
        value.metadata.active = true;

        // Handle case where internal ordering may have changed
        if (value.previous !== previousId) {
            changed = true;
            value.previous = previousId;
        }

        // Handle case where parent might have been updated
        if (value.parent !== parentId) {
            changed = true;
            const oldParentId = value.parent;
            value.parent = parentId;
            // Move this node to the right location under new parent
            if (parentId !== null && parentId >= 0) {
                const childIndex = previousId === null ? 0 : values[parentId].children.indexOf(previousId) + 1;
                values[parentId].children.splice(childIndex, 0, id);
                // Update region after the move
                value.region = region.exists(node) ? id : values[parentId].region;
            } else {
                // Mark this element as deleted if the parent has been updated to null
                remove(id, source);
            }

            // Remove reference to this node from the old parent
            if (oldParentId !== null && oldParentId >= 0) {
                const nodeIndex = values[oldParentId].children.indexOf(id);
                if (nodeIndex >= 0) {
                    values[oldParentId].children.splice(nodeIndex, 1);
                }
            }
            parentChanged = true;
        }

        // Update data
        for (const key in data) {
            if (diff(value.data, data, key)) {
                changed = true;
                value.data[key] = data[key];
            }
        }

        // Update selector
        updateSelector(value);
        track(id, source, changed, parentChanged);
    }
}

export function sameorigin(node: Node): boolean {
    let output = false;
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === Constant.IFrameTag) {
        const frame = node as HTMLIFrameElement;
        // To determine if the iframe is same-origin or not, we try accessing it's contentDocument.
        // If the browser throws an exception, we assume it's cross-origin and move on.
        // However, if we do a get a valid document object back, we assume the contents are accessible and iframe is same-origin.
        try {
            const doc = frame.contentDocument;
            if (doc) {
                iframeMap.set(frame.contentDocument, frame);
                iframeContentMap.set(frame, { doc: frame.contentDocument, win: frame.contentWindow });
                output = true;
            }
        } catch {
            /* do nothing */
        }
    }
    return output;
}

export function iframe(node: Node): HTMLIFrameElement {
    const doc = node.nodeType === Node.DOCUMENT_NODE ? (node as Document) : null;
    return doc && iframeMap.has(doc) ? iframeMap.get(doc) : null;
}

export function iframeContent(frame: HTMLIFrameElement): { doc: Document; win: Window } {
    if (iframeContentMap.has(frame)) {
        return iframeContentMap.get(frame);
    }
    return null;
}

export function removeIFrame(frame: HTMLIFrameElement, doc: Document): void {
    iframeContentMap.delete(frame);
    iframeMap.delete(doc);
}

function privacy(node: Node, value: NodeValue, parent: NodeValue): void {
    const data = value.data;
    const metadata = value.metadata;
    const current = metadata.privacy;
    const attributes = data.attributes || {};
    const tag = data.tag.toUpperCase();

    switch (true) {
        case maskTags.indexOf(tag) >= 0: {
            const type = attributes[Constant.Type];
            let meta: string = Constant.Empty;
            const excludedPrivacyAttributes = [Constant.Class, Constant.Style];
            for (const x of Object.keys(attributes).filter((x) => !excludedPrivacyAttributes.includes(x as Constant))) {
                meta += attributes[x].toLowerCase();
            }
            const exclude = maskExclude.some((x) => meta.indexOf(x) >= 0);
            // Regardless of privacy mode, always mask off user input from input boxes or drop downs with two exceptions:
            // (1) The node is detected to be one of the excluded fields, in which case we drop everything
            // (2) The node's type is one of the allowed types (like checkboxes)
            metadata.privacy =
                tag === Constant.InputTag && maskDisable.indexOf(type) >= 0 ? current : exclude ? Privacy.Exclude : Privacy.Text;
            break;
        }
        case Constant.MaskData in attributes:
            metadata.privacy = Privacy.TextImage;
            break;
        case Constant.UnmaskData in attributes:
            metadata.privacy = Privacy.None;
            break;
        case privacyMap.has(node):
            // If this node was explicitly configured to contain sensitive content, honor that privacy setting
            metadata.privacy = privacyMap.get(node);
            break;
        case fraudMap.has(node):
            // If this node was explicitly configured to be evaluated for fraud, then also mask content
            metadata.privacy = Privacy.Text;
            break;
        case tag === Constant.TextTag: {
            // If it's a text node belonging to a STYLE or TITLE tag or one of scrub exceptions, then capture content
            const pTag = parent?.data ? parent.data.tag : Constant.Empty;
            const pSelector = parent?.selector ? parent.selector[Selector.Default] : Constant.Empty;
            const tags: string[] = [Constant.StyleTag, Constant.TitleTag, Constant.SvgStyle];
            metadata.privacy = tags.includes(pTag) || override.some((x) => pSelector.indexOf(x) >= 0) ? Privacy.None : current;
            break;
        }
        case current === Privacy.Sensitive:
            // In a mode where we mask sensitive information by default, look through class names to aggressively mask content
            metadata.privacy = inspect(attributes[Constant.Class], maskText, metadata);
            break;
        case tag === Constant.ImageTag:
            // Mask images with blob src as it is not publicly available anyway.
            if (attributes.src?.startsWith("blob:")) {
                metadata.privacy = Privacy.TextImage;
            }
            break;
    }
}

function inspect(input: string, lookup: string[], metadata: NodeMeta): Privacy {
    if (input && lookup.some((x) => input.indexOf(x) >= 0)) {
        return Privacy.Text;
    }
    return metadata.privacy;
}

function diff(a: NodeInfo, b: NodeInfo, field: string): boolean {
    if (typeof a[field] === "object" && typeof b[field] === "object") {
        for (const key in a[field]) {
            if (a[field][key] !== b[field][key]) {
                return true;
            }
        }
        for (const key in b[field]) {
            if (b[field][key] !== a[field][key]) {
                return true;
            }
        }
        return false;
    }
    return a[field] !== b[field];
}

function position(parent: NodeValue, child: NodeValue): number {
    child.metadata.position = 1;
    let idx = parent ? parent.children.indexOf(child.id) : -1;
    while (idx-- > 0) {
        const sibling = values[parent.children[idx]];
        if (child.data.tag === sibling.data.tag) {
            child.metadata.position = sibling.metadata.position + 1;
            break;
        }
    }
    return child.metadata.position;
}

function updateSelector(value: NodeValue): void {
    const parent = value.parent && value.parent in values ? values[value.parent] : null;
    const prefix = parent ? parent.selector : null;
    const d = value.data;
    const p = position(parent, value);
    const s: SelectorInput = { id: value.id, tag: d.tag, prefix, position: p, attributes: d.attributes };
    value.selector = [selector.get(s, Selector.Alpha), selector.get(s, Selector.Beta)];
    value.hash = value.selector.map((x) => (x ? hash(x) : null)) as [string, string];
    for (const h of value.hash) {
        hashMap[h] = value.id;
    }
}

export function hashText(hash: string): string {
    const id = lookup(hash);
    const node = getNode(id);
    return node !== null && node.textContent !== null ? node.textContent.substr(0, Setting.ClickText) : "";
}

export function getNode(id: number): Node {
    return nodesMap.has(id) ? nodesMap.get(id) : null;
}

export function getValue(id: number): NodeValue {
    if (id in values) {
        return values[id];
    }
    return null;
}

export function get(node: Node): NodeValue {
    const id = getId(node);
    return id in values ? values[id] : null;
}

export function lookup(hash: string): number {
    return hash in hashMap ? hashMap[hash] : null;
}

export function has(node: Node): boolean {
    return nodesMap.has(getId(node));
}

export function updates(): NodeValue[] {
    const output = [];
    for (const id of updateMap) {
        if (id in values) {
            output.push(values[id]);
        }
    }
    updateMap = [];

    return output;
}

function remove(id: number, source: Source): void {
    if (id in values) {
        const value = values[id];
        value.metadata.active = false;
        value.parent = null;
        track(id, source);

        // Clean up node references for removed nodes
        removeNodeFromNodesMap(id);
    }
}

function removeNodeFromNodesMap(id: number) {
    const nodeToBeRemoved = nodesMap.get(id);
    // Shadow dom roots shouldn't be deleted,
    // we should keep listening to the mutations there even they're not rendered in the DOM.
    if (nodeToBeRemoved?.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        return;
    }

    if (nodeToBeRemoved?.nodeType === Node.ELEMENT_NODE && (nodeToBeRemoved as Element).tagName === "IFRAME") {
        const iframe = nodeToBeRemoved as HTMLIFrameElement;
        removeObserver(iframe);
    }

    nodesMap.delete(id);

    const value = id in values ? values[id] : null;
    if (value?.children) {
        for (const childId of value.children) {
            removeNodeFromNodesMap(childId);
        }
    }
}

function updateImageSize(value: NodeValue): void {
    // If this element is a image node, and is masked, then track box model for the current element
    if (value.data.tag === Constant.ImageTag && value.metadata.privacy === Privacy.TextImage) {
        const img = getNode(value.id) as HTMLImageElement;
        // We will not capture the natural image dimensions until it loads.
        if (img && (!img.complete || img.naturalWidth === 0)) {
            // This will trigger mutation to update the original width and height after image loads.
            bind(img, "load", () => {
                img.setAttribute("data-clarity-loaded", `${shortid()}`);
            });
        }
        value.metadata.size = [];
    }
}

function getPreviousId(inputNode: Node): number {
    let id = null;
    let node = inputNode;

    // Some nodes may not have an ID by design since Clarity skips over tags like SCRIPT, NOSCRIPT, META, COMMENTS, etc..
    // In that case, we keep going back and check for their sibling until we find a sibling with ID or no more sibling nodes are left.
    while (id === null && node.previousSibling) {
        id = getId(node.previousSibling);
        node = node.previousSibling;
    }
    return id;
}

function track(id: number, source: Source, changed = true, parentChanged = false): void {
    if (config.lean && config.lite) {
        return;
    }

    // Keep track of the order in which mutations happened, they may not be sequential
    // Edge case: If an element is added later on, and pre-discovered element is moved as a child.
    // In that case, we need to reorder the pre-discovered element in the update list to keep visualization consistent.
    const uIndex = updateMap.indexOf(id);
    if (uIndex >= 0 && source === Source.ChildListAdd && parentChanged) {
        updateMap.splice(uIndex, 1);
        updateMap.push(id);
    } else if (uIndex === -1 && changed) {
        updateMap.push(id);
    }
}
