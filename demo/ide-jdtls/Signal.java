public class Signal {
    public static double average(double[] samples) {
        double total = 0;
        for (double value : samples) total += value;
        return total / samples.length;
    }

    public static void main(String[] args) {
        double amplitude = "high";
        System.out.println(amplitude);
    }
}
