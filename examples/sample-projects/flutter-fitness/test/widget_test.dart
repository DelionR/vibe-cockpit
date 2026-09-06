import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_fitness/main.dart';

void main() {
  testWidgets('renders title', (tester) async {
    await tester.pumpWidget(const FitnessApp());
    expect(find.text('Fitness'), findsOneWidget);
  });
}
