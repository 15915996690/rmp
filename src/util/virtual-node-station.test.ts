import { describe, expect, it } from 'vitest';
import { MultiDirectedGraph } from 'graphology';
import { EdgeAttributes, GraphAttributes, NodeAttributes } from '../constants/constants';
import { MiscNodeType } from '../constants/nodes';
import { StationType } from '../constants/stations';
import { createTestLineGraph } from '../test-utils';
import { resolveVirtualNodeReferences, resolveVirtualNodeToStation } from './virtual-node-station';

const attributes = (x: number, y: number, type: NodeAttributes['type']): NodeAttributes => ({
    x,
    y,
    type,
    visible: true,
    zIndex: 0,
    ...(type === MiscNodeType.Virtual
        ? { virtual: {} }
        : { 'shmetro-basic': { names: ['车站'], nameOffsetX: 'right', nameOffsetY: 'top' } }),
});

describe('virtual node station collision resolution', () => {
    it('resolves a virtual node inside a station collision fallback box', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        graph.addNode('stn_A', attributes(0, 0, StationType.ShmetroBasic));
        graph.addNode('misc_node_V', attributes(20, 10, MiscNodeType.Virtual));

        expect(resolveVirtualNodeToStation(graph, 'misc_node_V')).toBe('stn_A');
    });

    it('keeps a virtual node outside every station collision box', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        graph.addNode('stn_A', attributes(0, 0, StationType.ShmetroBasic));
        graph.addNode('misc_node_V', attributes(31, 0, MiscNodeType.Virtual));

        expect(resolveVirtualNodeToStation(graph, 'misc_node_V')).toBe('misc_node_V');
    });

    it('chooses the nearest station when collision boxes overlap', () => {
        const graph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>();
        graph.addNode('stn_A', attributes(0, 0, StationType.ShmetroBasic));
        graph.addNode('stn_B', attributes(40, 0, StationType.ShmetroBasic));
        graph.addNode('misc_node_V', attributes(30, 0, MiscNodeType.Virtual));

        expect(resolveVirtualNodeToStation(graph, 'misc_node_V')).toBe('stn_B');
    });

    it('resolves serialized graph edge endpoints as well', () => {
        const graph = createTestLineGraph(
            [
                ['A', 'V'],
                ['V', 'B'],
            ],
            ['V']
        );
        graph.setNodeAttribute('misc_node_V', 'x', 10);
        graph.setNodeAttribute('stn_B', 'x', 100);

        const resolved = resolveVirtualNodeReferences(graph.export());
        expect(resolved.edges[0].source).toBe('stn_A');
    });
});
