package forexplore.reference;

import forexplore.reference.application.ReferencePlatform;

public final class ReferenceCli {
    public static void main(String[] args) {
        ReferencePlatform platform = new ReferencePlatform();
        System.out.println(platform.quote("EUR", "USD"));
        System.out.println(platform.settle());
        System.out.println(platform.report());
    }
}

