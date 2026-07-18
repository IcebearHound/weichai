package forexplore.reference.infrastructure;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class ReplayLog {
    private final List<String> entries = new ArrayList<>();
    public synchronized void add(String value) { entries.add(value); }
    public synchronized List<String> readFrom(int index) {
        int start = Math.min(Math.max(0, index), entries.size());
        return List.copyOf(entries.subList(start, entries.size()));
    }
    public synchronized int size() { return entries.size(); }
    public synchronized void trimBefore(int index) {
        int end = Math.min(Math.max(0, index), entries.size());
        if (end > 0) entries.subList(0, end).clear();
    }
    public synchronized List<String> reversed() { List<String> copy = new ArrayList<>(entries); Collections.reverse(copy); return copy; }
}

