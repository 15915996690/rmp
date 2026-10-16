import type { MultiDirectedGraph } from 'graphology';
import type { SerializedGraph } from 'graphology-types';
import { EdgeAttributes, GraphAttributes, NodeAttributes, NodeId } from '../constants/constants';
import { MiscNodeType } from '../constants/nodes';

const FALLBACK_COLLISION_RADIUS = 30;

type Graph = SerializedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>;

type CollisionBox = { halfWidth: number; halfHeight: number };

const stationCollisionBoxes = new Map<string, CollisionBox>();
const resolvedGraphs = new WeakMap<Graph, Graph>();
type GraphologyGraph = MultiDirectedGraph<NodeAttributes, EdgeAttributes, GraphAttributes>;

const isVirtualNode = (attributes: NodeAttributes) => attributes.type === MiscNodeType.Virtual;

const getStationCollisionBox = (stationId: string): CollisionBox => {
    const cached = stationCollisionBoxes.get(stationId);
    if (cached) return cached;
    if (typeof document !== 'undefined') {
        const element = document.getElementById(`stn_core_${stationId}`);
        if (element && 'getBBox' in element) {
            try {
                const box = (element as unknown as SVGGraphicsElement).getBBox();
                if (box.width > 0 && box.height > 0) {
                    const result = { halfWidth: box.width / 2, halfHeight: box.height / 2 };
                    stationCollisionBoxes.set(stationId, result);
                    return result;
                }
            } catch {
                // SVG layout is unavailable during initial render or in tests.
            }
        }
    }
    const result = { halfWidth: FALLBACK_COLLISION_RADIUS, halfHeight: FALLBACK_COLLISION_RADIUS };
    stationCollisionBoxes.set(stationId, result);
    return result;
};

const isInsideStationCollisionBox = (virtual: NodeAttributes, station: NodeAttributes, stationId: string): boolean => {
    const { halfWidth, halfHeight } = getStationCollisionBox(stationId);
    return Math.abs(virtual.x - station.x) <= halfWidth && Math.abs(virtual.y - station.y) <= halfHeight;
};

export const resolveVirtualNodeToStation = (graph: GraphologyGraph, nodeId: NodeId): NodeId => {
    if (!graph.hasNode(nodeId) || !isVirtualNode(graph.getNodeAttributes(nodeId))) return nodeId;
    const virtual = graph.getNodeAttributes(nodeId);
    const candidates = graph
        .filterNodes((candidateId, attributes) => {
            if (!candidateId.startsWith('stn_')) return false;
            return isInsideStationCollisionBox(virtual, attributes, candidateId);
        })
        .map(candidateId => candidateId as NodeId);
    return (
        candidates.sort((a, b) => {
            const aa = graph.getNodeAttributes(a);
            const bb = graph.getNodeAttributes(b);
            return Math.hypot(virtual.x - aa.x, virtual.y - aa.y) - Math.hypot(virtual.x - bb.x, virtual.y - bb.y);
        })[0] ?? nodeId
    );
};

export const resolveVirtualNodeReferences = (graph: Graph): Graph => {
    const cached = resolvedGraphs.get(graph);
    if (cached) return cached;

    const nodeMap = new Map(graph.nodes.map(node => [node.key, node]));
    // 同一节点在边的端点中会出现很多次，解析结果记忆化，避免重复遍历全部车站
    const resolvedIds = new Map<string, string>();
    const resolve = (nodeId: string): string => {
        const memo = resolvedIds.get(nodeId);
        if (memo !== undefined) return memo;

        const node = nodeMap.get(nodeId);
        if (!node?.attributes || !isVirtualNode(node.attributes)) {
            resolvedIds.set(nodeId, nodeId);
            return nodeId;
        }

        const virtual = node.attributes;
        const candidates = graph.nodes.filter(candidate => {
            const attributes = candidate.attributes;
            return (
                !!attributes &&
                candidate.key.startsWith('stn_') &&
                isInsideStationCollisionBox(virtual, attributes, candidate.key)
            );
        });
        candidates.sort((a, b) => {
            const aAttributes = a.attributes!;
            const bAttributes = b.attributes!;
            return (
                Math.hypot(virtual.x - aAttributes.x, virtual.y - aAttributes.y) -
                Math.hypot(virtual.x - bAttributes.x, virtual.y - bAttributes.y)
            );
        });
        const result = candidates[0]?.key ?? nodeId;
        resolvedIds.set(nodeId, result);
        return result;
    };

    const edges = graph.edges.map(edge => ({ ...edge, source: resolve(edge.source), target: resolve(edge.target) }));
    const seen = new Set<string>();
    const uniqueEdges = edges.filter(edge => {
        const key = `${edge.source}\u0000${edge.target}\u0000${edge.key}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const resolved = { ...graph, edges: uniqueEdges };
    resolvedGraphs.set(graph, resolved);
    return resolved;
};
